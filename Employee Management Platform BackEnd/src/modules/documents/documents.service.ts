import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { ConflictError, NotFoundError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanViewDocuments,
  assertCanEditEmployee,
  canViewConfidentialDocuments,
  isManagement,
  isSelf,
  scopedEntityId,
} from '../../services/access';
import { isLockedPayrollStatus } from '../../services/payroll-lock';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee } from '../../services/notification.service';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Documents are metadata records pointing at a file URL.
 *
 * Binary upload and object storage are deliberately out of scope for this
 * prototype - they add infrastructure without demonstrating anything about the
 * HR domain. The model is storage-agnostic, so swapping `fileUrl` for an S3 or
 * Supabase Storage key later touches one field.
 *
 * The one exception is files the platform generates itself - payslip PDFs -
 * whose bytes live in `document_files` and are served by the download route.
 * Listing never loads them.
 */
export const createDocumentSchema = z.object({
  category: z.enum(['CONTRACT', 'IDENTIFICATION', 'VISA_PERMIT', 'CERTIFICATE', 'LETTER', 'PAYSLIP', 'OTHER']),
  title: requiredTrimmedString(2, 160),
  fileName: requiredTrimmedString(2, 200),
  fileUrl: z.string().trim().url().max(1000),
  mimeType: optionalTrimmedString(100),
  sizeBytes: z.coerce.number().int().nonnegative().max(50_000_000).default(0),
  issuedOn: dateStringSchema.optional(),
  expiresOn: dateStringSchema.optional(),
  /** Confidential records are visible to HR only, not to the employee. */
  isConfidential: z.boolean().default(false),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

const DOCUMENT_CATEGORIES = ['CONTRACT', 'IDENTIFICATION', 'VISA_PERMIT', 'CERTIFICATE', 'LETTER', 'PAYSLIP', 'OTHER'] as const;

export const documentQuerySchema = paginationSchema.extend({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  employeeId: optionalTrimmedString(40),
  /** Expired, or expiring within 90 days. */
  expiring: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  q: optionalTrimmedString(120),
});

export type DocumentQuery = z.infer<typeof documentQuerySchema>;


async function loadSubject(employeeId: string) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true },
  });
  if (!employee) {
    throw new NotFoundError('Employee');
  }
  return employee;
}

export async function listEmployeeDocuments(auth: AuthContext, employeeId: string): Promise<unknown[]> {
  const employee = await loadSubject(employeeId);
  assertCanViewDocuments(auth, employee);

  const documents = await prisma.document.findMany({
    where: {
      employeeId,
      // An employee sees their own documents except those HR marked confidential.
      ...(canViewConfidentialDocuments(auth, employee) ? {} : { isConfidential: false }),
    },
    // Only the file's id: the bytes stay in the database until someone downloads.
    include: { file: { select: { id: true } } },
    orderBy: [{ createdAt: 'desc' }],
  });

  const today = new Date();
  return documents.map((document) => ({
    id: document.id,
    category: document.category,
    title: document.title,
    fileName: document.fileName,
    fileUrl: document.fileUrl,
    hasStoredFile: Boolean(document.file),
    downloadUrl: document.file ? `/api/v1/documents/${document.id}/download` : null,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    issuedOn: document.issuedOn?.toISOString().slice(0, 10) ?? null,
    expiresOn: document.expiresOn?.toISOString().slice(0, 10) ?? null,
    isConfidential: document.isConfidential,
    isExpired: document.expiresOn ? document.expiresOn < today : false,
    daysUntilExpiry: document.expiresOn
      ? Math.ceil((document.expiresOn.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
      : null,
    createdAt: document.createdAt,
  }));
}

export async function createEmployeeDocument(
  auth: AuthContext,
  employeeId: string,
  input: CreateDocumentInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const employee = await loadSubject(employeeId);
  assertCanEditEmployee(auth, employee);

  const document = await prisma.document.create({
    data: {
      employeeId,
      category: input.category,
      title: input.title,
      fileName: input.fileName,
      fileUrl: input.fileUrl,
      mimeType: input.mimeType ?? 'application/pdf',
      sizeBytes: input.sizeBytes,
      issuedOn: input.issuedOn ? toUtcDate(input.issuedOn) : null,
      expiresOn: input.expiresOn ? toUtcDate(input.expiresOn) : null,
      isConfidential: input.isConfidential,
      uploadedById: auth.userId,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'Document',
    entityId: document.id,
    legalEntityId: employee.legalEntityId,
    summary: `Added ${input.category} document "${input.title}" for employee ${employee.employeeNumber}`,
    actor: auth,
    ...fingerprint,
  });

  if (!input.isConfidential) {
    await notifyEmployee(employeeId, {
      type: 'DOCUMENT_ISSUED',
      title: 'A new document was added to your profile',
      body: input.title,
      entityType: 'Document',
      entityId: document.id,
    });
  }

  return document;
}

/**
 * Returns the letter body for a document.
 *
 * Split from the list endpoint because the body is large and only wanted when
 * someone actually opens the letter. Access follows the same rule as the rest
 * of the document surface: HR within scope, or the employee it belongs to -
 * and a confidential record stays hidden from the employee.
 */
export async function getDocumentContent(auth: AuthContext, documentId: string): Promise<unknown> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      category: true,
      fileName: true,
      contentEn: true,
      contentAr: true,
      isAiGenerated: true,
      issuedOn: true,
      isConfidential: true,
      employee: { select: { id: true, legalEntityId: true, managerId: true, firstName: true, lastName: true } },
    },
  });

  if (!document) {
    throw new NotFoundError('Document');
  }

  assertCanViewDocuments(auth, document.employee);
  if (document.isConfidential && !canViewConfidentialDocuments(auth, document.employee)) {
    throw new NotFoundError('Document');
  }

  return {
    id: document.id,
    title: document.title,
    category: document.category,
    fileName: document.fileName,
    contentEn: document.contentEn,
    contentAr: document.contentAr,
    isAiGenerated: document.isAiGenerated,
    issuedOn: document.issuedOn?.toISOString().slice(0, 10) ?? null,
    employeeName: `${document.employee.firstName} ${document.employee.lastName}`,
  };
}

/**
 * The stored bytes of a platform-generated document. Same access rule as
 * reading a document; HR opening someone's payslip is recorded in the audit
 * trail because a payslip is pay data.
 */
export async function downloadDocumentFile(
  auth: AuthContext,
  documentId: string,
  fingerprint: Fingerprint,
): Promise<{ fileName: string; mimeType: string; data: Buffer }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      category: true,
      fileName: true,
      isConfidential: true,
      employee: { select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true } },
      file: { select: { data: true, mimeType: true } },
    },
  });
  if (!document) {
    throw new NotFoundError('Document');
  }
  assertCanViewDocuments(auth, document.employee);
  if (document.isConfidential && !canViewConfidentialDocuments(auth, document.employee)) {
    throw new NotFoundError('Document');
  }
  if (!document.file) {
    throw new NotFoundError('Stored file');
  }

  if (document.category === 'PAYSLIP' && !isSelf(auth, document.employee)) {
    await recordAudit({
      action: 'VIEW_SENSITIVE',
      entityType: 'Document',
      entityId: document.id,
      legalEntityId: document.employee.legalEntityId,
      summary: `Downloaded "${document.title}" of employee ${document.employee.employeeNumber}`,
      actor: auth,
      ...fingerprint,
    });
  }

  return { fileName: document.fileName, mimeType: document.file.mimeType, data: Buffer.from(document.file.data) };
}

export async function deleteEmployeeDocument(
  auth: AuthContext,
  documentId: string,
  fingerprint: Fingerprint,
): Promise<void> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      employee: { select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true } },
      payslipFor: { select: { period: { select: { status: true, name: true } } } },
    },
  });
  if (!document) {
    throw new NotFoundError('Document');
  }
  assertCanEditEmployee(auth, document.employee);
  // A payslip is part of an approved payroll. It is withdrawn by reopening
  // that payroll - which is audited as such - never by deleting the file.
  if (document.payslipFor && isLockedPayrollStatus(document.payslipFor.period.status)) {
    throw new ConflictError(
      `This payslip belongs to the ${document.payslipFor.period.status.toLowerCase()} payroll for ${document.payslipFor.period.name} and cannot be deleted`,
    );
  }

  await prisma.document.delete({ where: { id: documentId } });

  await recordAudit({
    action: 'DELETE',
    entityType: 'Document',
    entityId: documentId,
    legalEntityId: document.employee.legalEntityId,
    summary: `Deleted document "${document.title}" from employee ${document.employee.employeeNumber}`,
    actor: auth,
    ...fingerprint,
  });
}

/**
 * The document library. HR sees every document in scope - the place to chase
 * expiring visas and passports; anyone else sees their own documents, minus
 * those HR marked confidential. Never loads file bytes.
 */
export async function listDocuments(
  auth: AuthContext,
  query: DocumentQuery,
): Promise<{ items: unknown[]; meta: PageMeta; summary: Record<string, number> }> {
  const filters: Prisma.DocumentWhereInput[] = [];
  if (isManagement(auth)) {
    const scope = scopedEntityId(auth);
    if (scope) filters.push({ employee: { legalEntityId: scope } });
    if (query.employeeId) filters.push({ employeeId: query.employeeId });
  } else if (auth.employeeId) {
    filters.push({ employeeId: auth.employeeId, isConfidential: false });
  } else {
    filters.push({ id: '__none__' });
  }
  if (query.category) filters.push({ category: query.category });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizon = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
  if (query.expiring) filters.push({ expiresOn: { lte: horizon } });
  if (query.q) {
    filters.push({
      OR: [
        { title: { contains: query.q, mode: 'insensitive' } },
        { fileName: { contains: query.q, mode: 'insensitive' } },
        { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }
  const where: Prisma.DocumentWhereInput = filters.length ? { AND: filters } : {};
  const { skip, take } = toSkipTake(query);

  const [documents, total, expiringCount, expiredCount] = await Promise.all([
    prisma.document.findMany({
      where,
      select: {
        id: true,
        category: true,
        title: true,
        fileName: true,
        fileUrl: true,
        mimeType: true,
        sizeBytes: true,
        issuedOn: true,
        expiresOn: true,
        isConfidential: true,
        createdAt: true,
        file: { select: { id: true } },
        employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } },
      },
      orderBy: query.expiring ? [{ expiresOn: 'asc' }] : [{ createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.document.count({ where }),
    prisma.document.count({ where: { AND: [...filters, { expiresOn: { gte: today, lte: horizon } }] } }),
    prisma.document.count({ where: { AND: [...filters, { expiresOn: { lt: today } }] } }),
  ]);

  return {
    items: documents.map((document) => ({
      id: document.id,
      category: document.category,
      title: document.title,
      fileName: document.fileName,
      fileUrl: document.fileUrl,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      issuedOn: document.issuedOn?.toISOString().slice(0, 10) ?? null,
      expiresOn: document.expiresOn?.toISOString().slice(0, 10) ?? null,
      isConfidential: document.isConfidential,
      isExpired: document.expiresOn ? document.expiresOn < today : false,
      daysUntilExpiry: document.expiresOn
        ? Math.ceil((document.expiresOn.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
        : null,
      hasStoredFile: Boolean(document.file),
      downloadUrl: document.file ? `/api/v1/documents/${document.id}/download` : null,
      createdAt: document.createdAt,
      employee: {
        id: document.employee.id,
        employeeNumber: document.employee.employeeNumber,
        fullName: `${document.employee.firstName} ${document.employee.lastName}`,
      },
    })),
    meta: buildPageMeta(query.page, query.pageSize, total),
    summary: { total, expiringSoon: expiringCount, expired: expiredCount },
  };
}
