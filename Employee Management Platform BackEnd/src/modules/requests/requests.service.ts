import { Prisma } from '@prisma/client';
import type { RequestType } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../common/http';
import { toUtcDate } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanCancelRequest,
  assertCanDecideRequest,
  canViewRequest,
  entityScopeWhere,
  isManagement,
  scopedEntityId,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyApprovers, notifyEmployee } from '../../services/notification.service';
import { assertNoOverlappingLeave, calculateLeaveDays } from '../leave/leave.service';
import { generateLetter, type GeneratedLetter, type LetterFacts } from '../ai/letter.service';
import type {
  DecisionInput,
  DocumentRequestInput,
  LeaveRequestInput,
  ProfileChangeRequestInput,
  RejectionInput,
  RequestQuery,
} from './requests.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const REFERENCE_PREFIX: Record<RequestType, string> = {
  LEAVE: 'LV',
  DOCUMENT: 'DOC',
  PROFILE_CHANGE: 'PRC',
};

const DOCUMENT_TITLES: Record<DocumentRequestInput['documentType'], string> = {
  EMPLOYMENT_CERTIFICATE: 'Employment Certificate',
  SALARY_CERTIFICATE: 'Salary Certificate',
  EXPERIENCE_LETTER: 'Experience Letter',
  NOC_TRAVEL: 'No Objection Certificate (Travel)',
  VISA_LETTER: 'Visa Support Letter',
  BANK_ACCOUNT_LETTER: 'Bank Account Opening Letter',
};

const PROFILE_FIELD_LABELS: Record<string, string> = {
  preferredName: 'Preferred name',
  personalEmail: 'Personal email',
  phone: 'Phone number',
  addressLine: 'Address',
  city: 'City',
  country: 'Country',
  emergencyContactName: 'Emergency contact name',
  emergencyContactPhone: 'Emergency contact phone',
  emergencyContactRelation: 'Emergency contact relation',
};

interface ProfileChangeEntry {
  field: string;
  label: string;
  currentValue: string | null;
  proposedValue: string;
}

/**
 * Human-readable, per-type, per-year reference: LV-2026-0031.
 *
 * The value is derived inside the transaction and protected by a unique
 * constraint; `withReferenceRetry` re-runs the whole operation if two requests
 * are submitted at the same instant.
 */
async function nextReference(tx: TxClient, type: RequestType): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `${REFERENCE_PREFIX[type]}-${year}-`;

  const latest = await tx.request.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });

  const lastSequence = latest ? Number.parseInt(latest.reference.slice(prefix.length), 10) : 0;
  const next = Number.isNaN(lastSequence) ? 1 : lastSequence + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function withReferenceRetry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const isReferenceClash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference');
      if (!isReferenceClash || attempt === attempts) throw error;
    }
  }
  throw new ConflictError('Could not allocate a request reference, please retry');
}

/**
 * Decides whose request is being filed.
 *
 * An employee may only file for themselves. HR may file on behalf of someone in
 * their scope, which is what happens when a request arrives by email or in
 * person and HR enters it.
 */
async function resolveRequester(auth: AuthContext, explicitEmployeeId?: string) {
  const targetId = explicitEmployeeId ?? auth.employeeId;

  if (!targetId) {
    throw new ValidationError('Validation failed', {
      employeeId: ['This account is not linked to an employee record'],
    });
  }

  if (targetId !== auth.employeeId && !isManagement(auth)) {
    throw new ForbiddenError('You can only submit requests for yourself');
  }

  const employee = await prisma.employee.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      gender: true,
      status: true,
      managerId: true,
      legalEntityId: true,
      legalEntity: { select: { id: true, name: true, currency: true } },
    },
  });

  if (!employee) {
    throw new NotFoundError('Employee');
  }

  const scope = scopedEntityId(auth);
  if (targetId !== auth.employeeId && scope && scope !== employee.legalEntityId) {
    throw new ForbiddenError('This employee belongs to a legal entity outside your access scope');
  }

  if (employee.status === 'OFFBOARDED') {
    throw new ValidationError('Validation failed', {
      employeeId: ['Requests cannot be filed for an offboarded employee'],
    });
  }

  return employee;
}

const requestInclude = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      avatarUrl: true,
      managerId: true,
      legalEntityId: true,
      department: { select: { id: true, name: true } },
      legalEntity: { select: { id: true, code: true, name: true, countryCode: true } },
    },
  },
  decidedBy: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } },
  leaveDetail: { include: { leaveType: { select: { id: true, code: true, name: true, colorHex: true, isPaid: true } } } },
  documentDetail: {
    include: {
      issuedDocument: {
        select: {
          id: true,
          title: true,
          fileUrl: true,
          fileName: true,
          contentEn: true,
          contentAr: true,
          isAiGenerated: true,
        },
      },
    },
  },
  profileChangeDetail: true,
} satisfies Prisma.RequestInclude;

type RequestRow = Prisma.RequestGetPayload<{ include: typeof requestInclude }>;

/**
 * `includePrivate` gates the free-text the employee wrote - the reason for
 * leave, the purpose of a letter. Everyone who can see the request knows it
 * exists and what it is; only the employee, their manager and HR see why.
 */
function serializeRequest(request: RequestRow, includePrivate: boolean): Record<string, unknown> {
  const base = {
    id: request.id,
    reference: request.reference,
    type: request.type,
    status: request.status,
    submittedAt: request.submittedAt,
    decidedAt: request.decidedAt,
    decisionNote: request.decisionNote,
    cancelledAt: request.cancelledAt,
    employee: {
      id: request.employee.id,
      employeeNumber: request.employee.employeeNumber,
      fullName: `${request.employee.firstName} ${request.employee.lastName}`,
      jobTitle: request.employee.jobTitle,
      avatarUrl: request.employee.avatarUrl,
      department: request.employee.department,
      legalEntity: request.employee.legalEntity,
    },
    decidedBy: request.decidedBy
      ? {
          id: request.decidedBy.id,
          email: request.decidedBy.email,
          fullName: request.decidedBy.employee
            ? `${request.decidedBy.employee.firstName} ${request.decidedBy.employee.lastName}`
            : request.decidedBy.email,
        }
      : null,
  };

  if (request.leaveDetail) {
    return {
      ...base,
      leave: {
        leaveType: request.leaveDetail.leaveType,
        startDate: request.leaveDetail.startDate.toISOString().slice(0, 10),
        endDate: request.leaveDetail.endDate.toISOString().slice(0, 10),
        halfDayStart: request.leaveDetail.halfDayStart,
        halfDayEnd: request.leaveDetail.halfDayEnd,
        workingDays: Number(request.leaveDetail.workingDays),
        reason: includePrivate ? request.leaveDetail.reason : null,
        handoverNotes: includePrivate ? request.leaveDetail.handoverNotes : null,
        attachmentUrl: includePrivate ? request.leaveDetail.attachmentUrl : null,
      },
    };
  }

  if (request.documentDetail) {
    return {
      ...base,
      document: {
        documentType: request.documentDetail.documentType,
        title: DOCUMENT_TITLES[request.documentDetail.documentType],
        purpose: includePrivate ? request.documentDetail.purpose : null,
        addressedTo: includePrivate ? request.documentDetail.addressedTo : null,
        includeSalary: request.documentDetail.includeSalary,
        language: request.documentDetail.language,
        issuedDocument: request.documentDetail.issuedDocument,
      },
    };
  }

  if (request.profileChangeDetail) {
    return {
      ...base,
      profileChange: {
        // The proposed values are personal data, so they follow the same rule as
        // a leave reason.
        changes: includePrivate ? (request.profileChangeDetail.changes as unknown) : null,
        changeCount: Array.isArray(request.profileChangeDetail.changes)
          ? request.profileChangeDetail.changes.length
          : 0,
        appliedAt: request.profileChangeDetail.appliedAt,
      },
    };
  }

  return base;
}

async function loadRequestOrThrow(requestId: string): Promise<RequestRow> {
  const request = await prisma.request.findUnique({ where: { id: requestId }, include: requestInclude });
  if (!request) {
    throw new NotFoundError('Request');
  }
  return request;
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

/**
 * Reserves the requested days against the employee's balance at submission time.
 *
 * Holding them as `pendingDays` rather than waiting for approval is what stops
 * someone booking the same twenty days three times over while the first request
 * sits in an approver's queue.
 */
async function reserveLeaveBalance(
  tx: TxClient,
  params: { employeeId: string; leaveTypeId: string; year: number; days: number; entitlement: number },
): Promise<void> {
  const balance = await tx.leaveBalance.upsert({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: params.employeeId,
        leaveTypeId: params.leaveTypeId,
        year: params.year,
      },
    },
    update: {},
    create: {
      employeeId: params.employeeId,
      leaveTypeId: params.leaveTypeId,
      year: params.year,
      entitledDays: new Prisma.Decimal(params.entitlement),
    },
  });

  const available =
    Number(balance.entitledDays) +
    Number(balance.carriedOverDays) -
    Number(balance.usedDays) -
    Number(balance.pendingDays);

  if (params.days > available) {
    throw new ValidationError('Validation failed', {
      endDate: [
        `This request needs ${params.days} day(s) but only ${available.toFixed(1)} remain, including requests awaiting a decision`,
      ],
    });
  }

  await tx.leaveBalance.update({
    where: { id: balance.id },
    data: { pendingDays: { increment: new Prisma.Decimal(params.days) } },
  });
}

export async function submitLeaveRequest(
  auth: AuthContext,
  input: LeaveRequestInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const employee = await resolveRequester(auth, input.employeeId);

  const startDate = toUtcDate(input.startDate);
  const endDate = toUtcDate(input.endDate);

  // Balances are tracked per calendar year, so a request has to sit inside one.
  // Splitting a year-end absence into two requests keeps the accounting honest.
  if (startDate.getUTCFullYear() !== endDate.getUTCFullYear()) {
    throw new ValidationError('Validation failed', {
      endDate: ['Leave spanning two calendar years must be submitted as two requests'],
    });
  }

  const leaveType = await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
  if (!leaveType || !leaveType.isActive) {
    throw new ValidationError('Validation failed', { leaveTypeId: ['Unknown or inactive leave type'] });
  }
  if (leaveType.legalEntityId && leaveType.legalEntityId !== employee.legalEntityId) {
    throw new ValidationError('Validation failed', {
      leaveTypeId: ['This leave type does not apply to the employee legal entity'],
    });
  }
  if (leaveType.restrictedToGender && leaveType.restrictedToGender !== employee.gender) {
    throw new ValidationError('Validation failed', {
      leaveTypeId: ['This leave type is not available for this employee'],
    });
  }
  if ((input.halfDayStart || input.halfDayEnd) && !leaveType.allowsHalfDay) {
    throw new ValidationError('Validation failed', {
      halfDayStart: ['This leave type must be taken in whole days'],
    });
  }
  if (input.attachmentUrl === undefined && leaveType.requiresAttachment) {
    throw new ValidationError('Validation failed', {
      attachmentUrl: [`${leaveType.name} requires a supporting document`],
    });
  }

  const { workingDays } = await calculateLeaveDays({
    legalEntityId: employee.legalEntityId,
    employeeId: employee.id,
    startDate,
    endDate,
    halfDayStart: input.halfDayStart,
    halfDayEnd: input.halfDayEnd,
  });

  if (workingDays <= 0) {
    throw new ValidationError('Validation failed', {
      startDate: ['The selected dates contain no working days for this legal entity'],
    });
  }
  if (leaveType.maxConsecutiveDays && workingDays > leaveType.maxConsecutiveDays) {
    throw new ValidationError('Validation failed', {
      endDate: [`${leaveType.name} allows at most ${leaveType.maxConsecutiveDays} consecutive days`],
    });
  }

  // Notice periods apply to the employee, not to HR filing a backdated absence.
  if (leaveType.minNoticeDays > 0 && auth.employeeId === employee.id) {
    const noticeDays = Math.floor((startDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (noticeDays < leaveType.minNoticeDays) {
      throw new ValidationError('Validation failed', {
        startDate: [`${leaveType.name} requires at least ${leaveType.minNoticeDays} days notice`],
      });
    }
  }

  await assertNoOverlappingLeave(employee.id, startDate, endDate);

  const created = await withReferenceRetry(() =>
    prisma.$transaction(async (tx) => {
      await reserveLeaveBalance(tx, {
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        year: startDate.getUTCFullYear(),
        days: workingDays,
        entitlement: Number(leaveType.annualEntitlementDays),
      });

      const request = await tx.request.create({
        data: {
          reference: await nextReference(tx, 'LEAVE'),
          type: 'LEAVE',
          employeeId: employee.id,
          legalEntityId: employee.legalEntityId,
          leaveDetail: {
            create: {
              leaveTypeId: leaveType.id,
              startDate,
              endDate,
              halfDayStart: input.halfDayStart,
              halfDayEnd: input.halfDayEnd,
              workingDays: new Prisma.Decimal(workingDays),
              reason: input.reason,
              handoverNotes: input.handoverNotes ?? null,
              attachmentUrl: input.attachmentUrl ?? null,
            },
          },
        },
        include: requestInclude,
      });

      await recordAudit(
        {
          action: 'CREATE',
          entityType: 'Request',
          entityId: request.id,
          legalEntityId: employee.legalEntityId,
          summary: `Submitted ${leaveType.name} request ${request.reference} for ${workingDays} day(s)`,
          after: { startDate: input.startDate, endDate: input.endDate, workingDays },
          actor: auth,
          ...fingerprint,
        },
        tx,
      );

      return request;
    }),
  );

  await notifyApprovers(
    { legalEntityId: employee.legalEntityId, managerEmployeeId: employee.managerId },
    {
      type: 'REQUEST_SUBMITTED',
      title: `${leaveType.name} request from ${employee.firstName} ${employee.lastName}`,
      body: `${workingDays} day(s) from ${input.startDate} to ${input.endDate}. Reference ${created.reference}.`,
      entityType: 'Request',
      entityId: created.id,
    },
  );

  return serializeRequest(created, true);
}

export async function previewLeaveDays(
  auth: AuthContext,
  input: { startDate: string; endDate: string; halfDayStart: boolean; halfDayEnd: boolean; employeeId?: string },
): Promise<unknown> {
  const employee = await resolveRequester(auth, input.employeeId);
  const result = await calculateLeaveDays({
    legalEntityId: employee.legalEntityId,
    employeeId: employee.id,
    startDate: toUtcDate(input.startDate),
    endDate: toUtcDate(input.endDate),
    halfDayStart: input.halfDayStart,
    halfDayEnd: input.halfDayEnd,
  });

  return {
    workingDays: result.workingDays,
    holidaysInRange: result.holidays,
    legalEntity: employee.legalEntity,
  };
}

// ---------------------------------------------------------------------------
// Document requests
// ---------------------------------------------------------------------------

export async function submitDocumentRequest(
  auth: AuthContext,
  input: DocumentRequestInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const employee = await resolveRequester(auth, input.employeeId);

  // A salary certificate states the salary by definition; asking for one without
  // that flag produces a letter that does not serve its purpose.
  const includeSalary = input.documentType === 'SALARY_CERTIFICATE' ? true : input.includeSalary;

  const created = await withReferenceRetry(() =>
    prisma.$transaction(async (tx) => {
      const request = await tx.request.create({
        data: {
          reference: await nextReference(tx, 'DOCUMENT'),
          type: 'DOCUMENT',
          employeeId: employee.id,
          legalEntityId: employee.legalEntityId,
          documentDetail: {
            create: {
              documentType: input.documentType,
              purpose: input.purpose,
              addressedTo: input.addressedTo ?? null,
              includeSalary,
              language: input.language,
            },
          },
        },
        include: requestInclude,
      });

      await recordAudit(
        {
          action: 'CREATE',
          entityType: 'Request',
          entityId: request.id,
          legalEntityId: employee.legalEntityId,
          summary: `Requested ${DOCUMENT_TITLES[input.documentType]} (${request.reference})`,
          actor: auth,
          ...fingerprint,
        },
        tx,
      );

      return request;
    }),
  );

  await notifyApprovers(
    { legalEntityId: employee.legalEntityId, managerEmployeeId: employee.managerId },
    {
      type: 'REQUEST_SUBMITTED',
      title: `${DOCUMENT_TITLES[input.documentType]} requested`,
      body: `${employee.firstName} ${employee.lastName} requested a document. Reference ${created.reference}.`,
      entityType: 'Request',
      entityId: created.id,
    },
  );

  return serializeRequest(created, true);
}

// ---------------------------------------------------------------------------
// Profile change requests
// ---------------------------------------------------------------------------

export async function submitProfileChangeRequest(
  auth: AuthContext,
  input: ProfileChangeRequestInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const employee = await resolveRequester(auth);

  const current = await prisma.employee.findUniqueOrThrow({
    where: { id: employee.id },
    select: {
      preferredName: true,
      personalEmail: true,
      phone: true,
      addressLine: true,
      city: true,
      country: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      emergencyContactRelation: true,
    },
  });

  // Capturing the current value alongside the proposed one gives the approver a
  // real before/after to review, instead of a list of new values with no context.
  const entries: ProfileChangeEntry[] = [];
  for (const [field, proposedValue] of Object.entries(input.changes)) {
    if (proposedValue === undefined) continue;
    const currentValue = (current as Record<string, string | null>)[field] ?? null;
    if (currentValue === proposedValue) continue;
    entries.push({
      field,
      label: PROFILE_FIELD_LABELS[field] ?? field,
      currentValue,
      proposedValue: String(proposedValue),
    });
  }

  if (entries.length === 0) {
    throw new ValidationError('Validation failed', {
      changes: ['The proposed values match what is already on record'],
    });
  }

  const existingPending = await prisma.request.findFirst({
    where: { employeeId: employee.id, type: 'PROFILE_CHANGE', status: 'PENDING' },
    select: { reference: true },
  });
  if (existingPending) {
    throw new ConflictError(
      `Profile change request ${existingPending.reference} is still awaiting a decision. Cancel it before submitting another.`,
    );
  }

  const created = await withReferenceRetry(() =>
    prisma.$transaction(async (tx) => {
      const request = await tx.request.create({
        data: {
          reference: await nextReference(tx, 'PROFILE_CHANGE'),
          type: 'PROFILE_CHANGE',
          employeeId: employee.id,
          legalEntityId: employee.legalEntityId,
          profileChangeDetail: { create: { changes: entries as unknown as Prisma.InputJsonValue } },
        },
        include: requestInclude,
      });

      await recordAudit(
        {
          action: 'CREATE',
          entityType: 'Request',
          entityId: request.id,
          legalEntityId: employee.legalEntityId,
          summary: `Proposed ${entries.length} profile change(s) (${request.reference})`,
          after: { fields: entries.map((entry) => entry.field) },
          actor: auth,
          ...fingerprint,
        },
        tx,
      );

      return request;
    }),
  );

  await notifyApprovers(
    { legalEntityId: employee.legalEntityId, managerEmployeeId: employee.managerId },
    {
      type: 'REQUEST_SUBMITTED',
      title: `Profile change from ${employee.firstName} ${employee.lastName}`,
      body: `${entries.length} field(s) proposed: ${entries.map((entry) => entry.label).join(', ')}.`,
      entityType: 'Request',
      entityId: created.id,
    },
  );

  return serializeRequest(created, true);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function buildRequestWhere(auth: AuthContext, query: RequestQuery): Prisma.RequestWhereInput {
  const filters: Prisma.RequestWhereInput[] = [];

  if (isManagement(auth)) {
    const scope = entityScopeWhere(auth);
    if (scope.legalEntityId) filters.push({ legalEntityId: scope.legalEntityId as string });
    if (query.myTeamOnly && auth.employeeId) {
      filters.push({ employee: { managerId: auth.employeeId } });
    }
  } else if (auth.role === 'MANAGER' && auth.employeeId) {
    // A manager sees their own requests plus those of their direct reports.
    filters.push({
      OR: [{ employeeId: auth.employeeId }, { employee: { managerId: auth.employeeId } }],
    });
  } else if (auth.employeeId) {
    filters.push({ employeeId: auth.employeeId });
  } else {
    // A login with no employee record and no management role sees nothing.
    filters.push({ id: '__none__' });
  }

  if (query.type) filters.push({ type: query.type });
  if (query.status) filters.push({ status: query.status });
  if (query.employeeId) filters.push({ employeeId: query.employeeId });
  if (query.legalEntityId) filters.push({ legalEntityId: query.legalEntityId });
  if (query.departmentId) filters.push({ employee: { departmentId: query.departmentId } });
  if (query.from) filters.push({ submittedAt: { gte: toUtcDate(query.from) } });
  if (query.to) {
    const to = toUtcDate(query.to);
    to.setUTCHours(23, 59, 59, 999);
    filters.push({ submittedAt: { lte: to } });
  }
  if (query.q) {
    filters.push({
      OR: [
        { reference: { contains: query.q, mode: 'insensitive' } },
        { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

export async function listRequests(
  auth: AuthContext,
  query: RequestQuery,
): Promise<{ items: Record<string, unknown>[]; meta: PageMeta; summary: Record<string, number> }> {
  const where = buildRequestWhere(auth, query);
  const { skip, take } = toSkipTake(query);

  const orderBy: Prisma.RequestOrderByWithRelationInput =
    query.sortBy === 'status'
      ? { status: query.sortOrder }
      : query.sortBy === 'type'
        ? { type: query.sortOrder }
        : { submittedAt: query.sortOrder };

  const [requests, total, grouped] = await Promise.all([
    prisma.request.findMany({ where, include: requestInclude, orderBy, skip, take }),
    prisma.request.count({ where }),
    // Status counts for the same filter set, so the inbox tabs show real numbers.
    prisma.request.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ]);

  const summary = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const row of grouped) {
    summary[row.status] = row._count._all;
  }

  return {
    items: requests.map((request) =>
      serializeRequest(request, canViewRequest(auth, request, request.employee.managerId)),
    ),
    meta: buildPageMeta(query.page, query.pageSize, total),
    summary,
  };
}

export async function getRequest(auth: AuthContext, requestId: string): Promise<Record<string, unknown>> {
  const request = await loadRequestOrThrow(requestId);

  if (!canViewRequest(auth, request, request.employee.managerId)) {
    // 404 rather than 403: confirming a reference exists would itself leak.
    throw new NotFoundError('Request');
  }

  return serializeRequest(request, true);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Assembles the facts an HR letter is allowed to state, straight from the
 * database.
 *
 * The salary is loaded only when the employee ticked "include my salary". When
 * they did not, no pay figure is read here at all, so there is nothing for the
 * drafting step to leak - the guarantee comes from the query, not from filtering
 * the output afterwards.
 */
async function buildLetterFacts(request: RequestRow): Promise<LetterFacts | null> {
  if (!request.documentDetail) return null;

  const employee = await prisma.employee.findUnique({
    where: { id: request.employeeId },
    select: {
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      hireDate: true,
      employmentType: true,
      status: true,
      nationality: true,
      department: { select: { name: true } },
      legalEntity: {
        select: { name: true, legalName: true, city: true, countryName: true, registrationNumber: true },
      },
    },
  });
  if (!employee) return null;

  let salary: LetterFacts['salary'] = null;
  if (request.documentDetail.includeSalary) {
    const current = await prisma.compensationRecord.findFirst({
      where: { employeeId: request.employeeId, isCurrent: true },
      select: { baseSalary: true, currency: true, payFrequency: true },
    });
    if (current) {
      salary = {
        amount: Number(current.baseSalary),
        currency: current.currency,
        frequency: current.payFrequency,
      };
    }
  }

  return {
    documentType: request.documentDetail.documentType,
    reference: request.reference,
    employeeName: `${employee.firstName} ${employee.lastName}`,
    employeeNumber: employee.employeeNumber,
    jobTitle: employee.jobTitle,
    department: employee.department?.name ?? 'the company',
    hireDate: employee.hireDate.toISOString().slice(0, 10),
    employmentType: employee.employmentType,
    status: employee.status,
    nationality: employee.nationality,
    legalEntityName: employee.legalEntity.legalName,
    legalEntityCity: employee.legalEntity.city,
    legalEntityCountry: employee.legalEntity.countryName,
    registrationNumber: employee.legalEntity.registrationNumber,
    purpose: request.documentDetail.purpose,
    addressedTo: request.documentDetail.addressedTo,
    salary,
    issuedOn: new Date().toISOString().slice(0, 10),
  };
}

/** Applies the type-specific side effect of an approval. */
async function applyApproval(
  tx: TxClient,
  request: RequestRow,
  auth: AuthContext,
  input: DecisionInput,
  letter?: GeneratedLetter,
): Promise<void> {
  if (request.leaveDetail) {
    const days = new Prisma.Decimal(request.leaveDetail.workingDays);
    // The days move from reserved to spent; the total charged never changes.
    await tx.leaveBalance.updateMany({
      where: {
        employeeId: request.employeeId,
        leaveTypeId: request.leaveDetail.leaveTypeId,
        year: request.leaveDetail.startDate.getUTCFullYear(),
      },
      data: { pendingDays: { decrement: days }, usedDays: { increment: days } },
    });
    return;
  }

  if (request.documentDetail) {
    /**
     * Issuing the letter creates the document record, stores the drafted body
     * and links it back to the request, so the employee can collect it from
     * their own documents page.
     *
     * `letter` was drafted before this transaction opened - an external model
     * call must never be made while holding a database lock.
     */
    const title = DOCUMENT_TITLES[request.documentDetail.documentType];
    const fileName = `${request.reference}-${request.documentDetail.documentType.toLowerCase()}.pdf`;
    const document = await tx.document.create({
      data: {
        employeeId: request.employeeId,
        category: 'LETTER',
        title,
        fileName,
        fileUrl: input.documentUrl ?? `/documents/generated/${fileName}`,
        contentEn: letter?.contentEn ?? null,
        contentAr: letter?.contentAr ?? null,
        isAiGenerated: letter?.isAiGenerated ?? false,
        issuedOn: new Date(),
        isConfidential: false,
        uploadedById: auth.userId,
      },
    });

    await tx.documentRequestDetail.update({
      where: { requestId: request.id },
      data: { issuedDocumentId: document.id },
    });
    return;
  }

  if (request.profileChangeDetail) {
    const changes = request.profileChangeDetail.changes as unknown as ProfileChangeEntry[];
    const data: Record<string, string> = {};
    for (const change of changes) {
      // Re-check the field against the allowlist at apply time. The submit
      // schema already restricts it, but this is the write that actually
      // touches the employee row.
      if (change.field in PROFILE_FIELD_LABELS) {
        data[change.field] = change.proposedValue;
      }
    }

    if (Object.keys(data).length > 0) {
      await tx.employee.update({ where: { id: request.employeeId }, data });
    }
    await tx.profileChangeRequestDetail.update({
      where: { requestId: request.id },
      data: { appliedAt: new Date() },
    });
  }
}

export async function approveRequest(
  auth: AuthContext,
  requestId: string,
  input: DecisionInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const request = await loadRequestOrThrow(requestId);
  assertCanDecideRequest(auth, request, request.employee.managerId);

  if (request.status !== 'PENDING') {
    throw new ConflictError(`This request is already ${request.status.toLowerCase()}`);
  }

  // Drafted outside the transaction: the model call can take seconds, and
  // holding a database lock open for that long would block other writers.
  // generateLetter never throws - it falls back to the template - so a model
  // outage cannot block an HR approval.
  let letter: GeneratedLetter | undefined;
  if (request.documentDetail) {
    const facts = await buildLetterFacts(request);
    if (facts) letter = await generateLetter(facts);
  }

  const updated = await prisma.$transaction(async (tx) => {
    await applyApproval(tx, request, auth, input, letter);

    const result = await tx.request.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
        decidedById: auth.userId,
        decisionNote: input.note ?? null,
      },
      include: requestInclude,
    });

    await recordAudit(
      {
        action: 'APPROVE',
        entityType: 'Request',
        entityId: requestId,
        legalEntityId: request.legalEntityId,
        summary: `Approved ${request.type} request ${request.reference}`,
        before: { status: 'PENDING' },
        after: { status: 'APPROVED', note: input.note ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return result;
  });

  await notifyEmployee(request.employeeId, {
    type: 'REQUEST_APPROVED',
    title: `Request ${request.reference} approved`,
    body: input.note ?? 'Your request has been approved.',
    entityType: 'Request',
    entityId: requestId,
  });

  return serializeRequest(updated, true);
}

export async function rejectRequest(
  auth: AuthContext,
  requestId: string,
  input: RejectionInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const request = await loadRequestOrThrow(requestId);
  assertCanDecideRequest(auth, request, request.employee.managerId);

  if (request.status !== 'PENDING') {
    throw new ConflictError(`This request is already ${request.status.toLowerCase()}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Rejecting leave returns the reserved days to the balance.
    if (request.leaveDetail) {
      await tx.leaveBalance.updateMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveDetail.leaveTypeId,
          year: request.leaveDetail.startDate.getUTCFullYear(),
        },
        data: { pendingDays: { decrement: new Prisma.Decimal(request.leaveDetail.workingDays) } },
      });
    }

    const result = await tx.request.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedById: auth.userId, decisionNote: input.note },
      include: requestInclude,
    });

    await recordAudit(
      {
        action: 'REJECT',
        entityType: 'Request',
        entityId: requestId,
        legalEntityId: request.legalEntityId,
        summary: `Rejected ${request.type} request ${request.reference}`,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', note: input.note },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return result;
  });

  await notifyEmployee(request.employeeId, {
    type: 'REQUEST_REJECTED',
    title: `Request ${request.reference} was not approved`,
    body: input.note,
    entityType: 'Request',
    entityId: requestId,
  });

  return serializeRequest(updated, true);
}

/**
 * Withdrawal by the employee. Only their own request, and only while it is
 * still pending - once a decision is recorded the history is fixed.
 */
export async function cancelRequest(
  auth: AuthContext,
  requestId: string,
  note: string | undefined,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const request = await loadRequestOrThrow(requestId);

  const isOwner = auth.employeeId === request.employeeId;
  // The owner, or HR within scope - a scoped HR admin cannot cancel another
  // entity's requests.
  assertCanCancelRequest(auth, request);

  if (request.status !== 'PENDING') {
    throw new ConflictError(`Only pending requests can be withdrawn; this one is ${request.status.toLowerCase()}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (request.leaveDetail) {
      await tx.leaveBalance.updateMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveDetail.leaveTypeId,
          year: request.leaveDetail.startDate.getUTCFullYear(),
        },
        data: { pendingDays: { decrement: new Prisma.Decimal(request.leaveDetail.workingDays) } },
      });
    }

    const result = await tx.request.update({
      where: { id: requestId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        decisionNote: note ?? (isOwner ? 'Withdrawn by employee' : 'Cancelled by HR'),
      },
      include: requestInclude,
    });

    await recordAudit(
      {
        action: 'CANCEL',
        entityType: 'Request',
        entityId: requestId,
        legalEntityId: request.legalEntityId,
        summary: `Cancelled ${request.type} request ${request.reference}`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return result;
  });

  if (!isOwner) {
    await notifyEmployee(request.employeeId, {
      type: 'REQUEST_CANCELLED',
      title: `Request ${request.reference} was cancelled`,
      body: note ?? 'Your request was cancelled by HR.',
      entityType: 'Request',
      entityId: requestId,
    });
  }

  return serializeRequest(updated, true);
}
