import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { NotFoundError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanViewDocuments,
  assertCanEditEmployee,
  canViewConfidentialDocuments,
} from '../../services/access';
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
    orderBy: [{ createdAt: 'desc' }],
  });

  const today = new Date();
  return documents.map((document) => ({
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

export async function deleteEmployeeDocument(
  auth: AuthContext,
  documentId: string,
  fingerprint: Fingerprint,
): Promise<void> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, title: true, employee: { select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true } } },
  });
  if (!document) {
    throw new NotFoundError('Document');
  }
  assertCanEditEmployee(auth, document.employee);

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
