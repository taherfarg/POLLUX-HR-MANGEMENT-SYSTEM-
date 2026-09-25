import { Prisma } from '@prisma/client';
import type { SalaryAdvanceStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanDecideAdvance,
  assertCanViewPayData,
  canViewPayData,
  isManagement,
  isSelf,
  managesEmployee,
  scopedEntityId,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyApprovers, notifyEmployee } from '../../services/notification.service';
import { getCompanySettings } from '../../services/company';
import { assertPayrollPeriodOpen } from '../../services/payroll-lock';
import { money, splitEvenly, sum, toAmount, ZERO } from '../../services/money';
import { toDateKey } from '../../services/working-days';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month such as 2026-10');
const amountSchema = z.coerce.number().positive('Enter an amount above zero').max(10_000_000);

export const advanceRequestSchema = z.object({
  amount: amountSchema,
  reason: requiredTrimmedString(3, 500),
  requestedInstallments: z.coerce.number().int().min(1).max(60).optional(),
  /** HR may file on behalf of an employee; employees only for themselves. */
  employeeId: optionalTrimmedString(40),
});

export const advanceApprovalSchema = z.object({
  approvedAmount: amountSchema.optional(),
  numberOfInstallments: z.coerce.number().int().min(1).max(60),
  repaymentStartMonth: monthSchema,
  note: optionalTrimmedString(500),
});

export const advanceRejectionSchema = z.object({ note: requiredTrimmedString(3, 500) });

export const advancePaymentSchema = z.object({
  paymentReference: optionalTrimmedString(120),
  note: optionalTrimmedString(500),
});

export const advanceRescheduleSchema = z.object({
  numberOfInstallments: z.coerce.number().int().min(1).max(60),
  repaymentStartMonth: monthSchema,
  reason: requiredTrimmedString(3, 500),
});

export const advanceQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  employeeId: optionalTrimmedString(40),
  q: optionalTrimmedString(120),
});

export type AdvanceRequestInput = z.infer<typeof advanceRequestSchema>;
export type AdvanceApprovalInput = z.infer<typeof advanceApprovalSchema>;
export type AdvanceRescheduleInput = z.infer<typeof advanceRescheduleSchema>;
export type AdvanceQuery = z.infer<typeof advanceQuerySchema>;

/** Statuses in which an advance is still "open" - one at a time unless policy allows more. */
const OPEN_STATUSES: SalaryAdvanceStatus[] = ['PENDING', 'APPROVED', 'PAID', 'ACTIVE'];

const advanceInclude = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      legalEntityId: true,
      managerId: true,
      department: { select: { id: true, name: true } },
    },
  },
  installments: {
    orderBy: { sequence: 'asc' },
    include: {
      payrollItem: { select: { id: true, record: { select: { period: { select: { id: true, name: true, status: true } } } } } },
    },
  },
} satisfies Prisma.SalaryAdvanceInclude;

type AdvanceRow = Prisma.SalaryAdvanceGetPayload<{ include: typeof advanceInclude }>;

function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function monthLabel(date: Date): string {
  return date.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * What the employee (and HR) sees: the original amount, what has been repaid
 * through payroll, what is left, and the next instalment. Repaid and remaining
 * are derived from the instalments themselves, so they cannot drift from them.
 */
function serializeAdvance(advance: AdvanceRow) {
  const deducted = advance.installments.filter((installment) => installment.status === 'DEDUCTED');
  const repaid = sum(deducted.map((installment) => installment.amount));
  const principal = advance.approvedAmount ?? advance.requestedAmount;
  const next = advance.installments.find((installment) => installment.status === 'SCHEDULED');
  const repaymentActive = ['PAID', 'ACTIVE', 'COMPLETED'].includes(advance.status);

  return {
    id: advance.id,
    reference: advance.reference,
    status: advance.status,
    currency: advance.currency,
    requestedAmount: toAmount(advance.requestedAmount),
    requestedInstallments: advance.requestedInstallments,
    approvedAmount: toAmount(advance.approvedAmount),
    originalAmount: toAmount(principal),
    repaidAmount: toAmount(repaid),
    remainingAmount: repaymentActive ? toAmount(advance.remainingAmount) : advance.status === 'APPROVED' ? toAmount(principal) : 0,
    installmentAmount: toAmount(advance.installmentAmount),
    numberOfInstallments: advance.numberOfInstallments,
    installmentsPaid: deducted.length,
    repaymentStartMonth: advance.repaymentStartDate ? toDateKey(advance.repaymentStartDate).slice(0, 7) : null,
    nextInstallment: next ? { dueMonth: toDateKey(next.dueMonth).slice(0, 7), amount: toAmount(next.amount), sequence: next.sequence } : null,
    reason: advance.reason,
    decisionNote: advance.decisionNote,
    requestDate: advance.requestDate,
    approvedAt: advance.approvedAt,
    rejectedAt: advance.rejectedAt,
    paidAt: advance.paidAt,
    paymentReference: advance.paymentReference,
    completedAt: advance.completedAt,
    cancelledAt: advance.cancelledAt,
    employee: {
      id: advance.employee.id,
      employeeNumber: advance.employee.employeeNumber,
      fullName: `${advance.employee.firstName} ${advance.employee.lastName}`,
      jobTitle: advance.employee.jobTitle,
      department: advance.employee.department,
    },
    installments: advance.installments.map((installment) => ({
      id: installment.id,
      sequence: installment.sequence,
      dueMonth: toDateKey(installment.dueMonth).slice(0, 7),
      dueMonthLabel: monthLabel(installment.dueMonth),
      amount: toAmount(installment.amount),
      status: installment.status,
      deductedAt: installment.deductedAt,
      payrollPeriod: installment.payrollItem?.record.period ?? null,
    })),
  };
}

async function loadAdvance(advanceId: string, client: TxClient = prisma): Promise<AdvanceRow> {
  const advance = await client.salaryAdvance.findUnique({ where: { id: advanceId }, include: advanceInclude });
  if (!advance) throw new NotFoundError('Salary advance');
  return advance;
}

async function nextReference(tx: TxClient): Promise<string> {
  const prefix = `ADV-${new Date().getUTCFullYear()}-`;
  const latest = await tx.salaryAdvance.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  const last = latest ? Number.parseInt(latest.reference.slice(prefix.length), 10) : 0;
  return `${prefix}${String((Number.isNaN(last) ? 0 : last) + 1).padStart(4, '0')}`;
}

async function withReferenceRetry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference');
      if (!clash || attempt >= attempts) throw error;
    }
  }
}

/** Instalments for a plan: evenly split, monthly from the start month. */
function buildInstallments(amount: Prisma.Decimal, count: number, start: Date, firstSequence = 1) {
  return splitEvenly(amount, count).map((part, index) => ({
    sequence: firstSequence + index,
    dueMonth: addMonths(start, index),
    amount: part,
  }));
}

/** Refuses a repayment plan that would start inside a locked payroll month. */
async function assertMonthOpen(legalEntityId: string, month: Date): Promise<void> {
  await assertPayrollPeriodOpen(prisma, legalEntityId, toDateKey(month));
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

export async function requestAdvance(
  auth: AuthContext,
  input: AdvanceRequestInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const employeeId = input.employeeId ?? auth.employeeId;
  if (!employeeId) {
    throw new ValidationError('Validation failed', { employeeId: ['This account is not linked to an employee record'] });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      legalEntityId: true,
      managerId: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      status: true,
      legalEntity: { select: { currency: true } },
      compensation: { where: { isCurrent: true }, select: { currency: true }, take: 1 },
    },
  });
  if (!employee) throw new NotFoundError('Employee');

  // An employee files for themselves; HR may file on someone's behalf.
  if (!isSelf(auth, employee) && !managesEmployee(auth, employee)) {
    throw new ForbiddenError('You can only request a salary advance for yourself');
  }
  if (employee.status === 'OFFBOARDED') {
    throw new ValidationError('Validation failed', { employeeId: ['Advances cannot be requested for an offboarded employee'] });
  }

  const settings = await getCompanySettings(employee.legalEntityId);
  const amount = money(input.amount);
  if (settings.maxAdvanceAmount && amount.greaterThan(settings.maxAdvanceAmount)) {
    throw new ValidationError('Validation failed', {
      amount: [`The maximum advance is ${settings.maxAdvanceAmount.toFixed(2)}`],
    });
  }
  if (input.requestedInstallments && input.requestedInstallments > settings.maxAdvanceInstallments) {
    throw new ValidationError('Validation failed', {
      requestedInstallments: [`Advances are repaid in at most ${settings.maxAdvanceInstallments} instalments`],
    });
  }
  if (!settings.allowConcurrentAdvances) {
    const open = await prisma.salaryAdvance.findFirst({
      where: { employeeId, status: { in: OPEN_STATUSES } },
      select: { reference: true, status: true },
    });
    if (open) {
      throw new ConflictError(`Advance ${open.reference} is still ${open.status.toLowerCase()}. Only one advance can be open at a time.`);
    }
  }

  const currency = employee.compensation[0]?.currency ?? employee.legalEntity.currency;

  const created = await withReferenceRetry(() =>
    prisma.$transaction(async (tx) => {
      const advance = await tx.salaryAdvance.create({
        data: {
          reference: await nextReference(tx),
          employeeId,
          legalEntityId: employee.legalEntityId,
          currency,
          requestedAmount: amount,
          requestedInstallments: input.requestedInstallments ?? null,
          reason: input.reason,
          createdById: auth.userId,
        },
        include: advanceInclude,
      });
      await recordAudit(
        {
          action: 'CREATE',
          entityType: 'SalaryAdvance',
          entityId: advance.id,
          legalEntityId: employee.legalEntityId,
          summary: `Salary advance ${advance.reference} requested: ${currency} ${amount.toFixed(2)} for ${employee.employeeNumber}`,
          after: { amount: amount.toFixed(2), requestedInstallments: input.requestedInstallments ?? null },
          actor: auth,
          ...fingerprint,
        },
        tx,
      );
      return advance;
    }),
  );

  // Pay decisions belong to HR, so the line manager is deliberately not notified.
  await notifyApprovers(
    { legalEntityId: employee.legalEntityId, managerEmployeeId: null },
    {
      type: 'REQUEST_SUBMITTED',
      title: `Salary advance request from ${employee.firstName} ${employee.lastName}`,
      body: `${currency} ${amount.toFixed(2)}. Reference ${created.reference}.`,
      entityType: 'SalaryAdvance',
      entityId: created.id,
    },
  );

  return serializeAdvance(created);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Advances are pay data: an employee sees their own, HR sees their scope.
 * A line manager has no view of their team's advances.
 */
export async function listAdvances(
  auth: AuthContext,
  query: AdvanceQuery,
): Promise<{ items: unknown[]; meta: PageMeta; summary: Record<string, number> }> {
  const filters: Prisma.SalaryAdvanceWhereInput[] = [];
  if (isManagement(auth)) {
    const scope = scopedEntityId(auth);
    if (scope) filters.push({ legalEntityId: scope });
    if (query.employeeId) filters.push({ employeeId: query.employeeId });
  } else if (auth.employeeId) {
    filters.push({ employeeId: auth.employeeId });
  } else {
    filters.push({ id: '__none__' });
  }
  if (query.q) {
    filters.push({
      OR: [
        { reference: { contains: query.q, mode: 'insensitive' } },
        { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }

  const base: Prisma.SalaryAdvanceWhereInput = filters.length ? { AND: filters } : {};
  const where: Prisma.SalaryAdvanceWhereInput = query.status ? { AND: [base, { status: query.status }] } : base;
  const { skip, take } = toSkipTake(query);

  const [advances, total, grouped, outstanding] = await Promise.all([
    prisma.salaryAdvance.findMany({ where, include: advanceInclude, orderBy: { requestDate: 'desc' }, skip, take }),
    prisma.salaryAdvance.count({ where }),
    prisma.salaryAdvance.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.salaryAdvance.aggregate({ where: { AND: [base, { status: { in: ['PAID', 'ACTIVE'] } }] }, _sum: { remainingAmount: true } }),
  ]);

  const summary: Record<string, number> = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    PAID: 0,
    ACTIVE: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    outstandingAmount: toAmount(outstanding._sum.remainingAmount ?? ZERO) ?? 0,
  };
  for (const row of grouped) summary[row.status] = row._count._all;

  return { items: advances.map(serializeAdvance), meta: buildPageMeta(query.page, query.pageSize, total), summary };
}

export async function getAdvance(auth: AuthContext, advanceId: string): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  if (!canViewPayData(auth, advance.employee)) {
    // 404, not 403: confirming that someone else has an advance is itself a leak.
    throw new NotFoundError('Salary advance');
  }
  return serializeAdvance(advance);
}

// ---------------------------------------------------------------------------
// Deciding and paying
// ---------------------------------------------------------------------------

export async function approveAdvance(
  auth: AuthContext,
  advanceId: string,
  input: AdvanceApprovalInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  assertCanDecideAdvance(auth, advance.employee);
  if (advance.status !== 'PENDING') {
    throw new ConflictError(`This advance is already ${advance.status.toLowerCase()}`);
  }

  const settings = await getCompanySettings(advance.legalEntityId);
  const approvedAmount = input.approvedAmount === undefined ? advance.requestedAmount : money(input.approvedAmount);
  if (approvedAmount.greaterThan(advance.requestedAmount)) {
    throw new ValidationError('Validation failed', { approvedAmount: ['You cannot approve more than was requested'] });
  }
  if (input.numberOfInstallments > settings.maxAdvanceInstallments) {
    throw new ValidationError('Validation failed', {
      numberOfInstallments: [`Advances are repaid in at most ${settings.maxAdvanceInstallments} instalments`],
    });
  }
  const start = monthStart(input.repaymentStartMonth);
  await assertMonthOpen(advance.legalEntityId, start);

  const installments = buildInstallments(approvedAmount, input.numberOfInstallments, start);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.salaryAdvanceInstallment.createMany({
      data: installments.map((installment) => ({ ...installment, advanceId })),
    });
    const result = await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: {
        status: 'APPROVED',
        approvedAmount,
        numberOfInstallments: input.numberOfInstallments,
        installmentAmount: installments[0]?.amount ?? approvedAmount,
        repaymentStartDate: start,
        remainingAmount: approvedAmount,
        approvedById: auth.userId,
        approvedAt: new Date(),
        decisionNote: input.note ?? null,
      },
      include: advanceInclude,
    });
    await recordAudit(
      {
        action: 'APPROVE',
        entityType: 'SalaryAdvance',
        entityId: advanceId,
        legalEntityId: advance.legalEntityId,
        summary: `Approved salary advance ${advance.reference}: ${advance.currency} ${approvedAmount.toFixed(2)} in ${input.numberOfInstallments} instalment(s) from ${input.repaymentStartMonth}`,
        before: { status: 'PENDING', requestedAmount: advance.requestedAmount.toFixed(2) },
        after: {
          status: 'APPROVED',
          approvedAmount: approvedAmount.toFixed(2),
          installments: installments.map((installment) => `${toDateKey(installment.dueMonth).slice(0, 7)}: ${installment.amount.toFixed(2)}`),
        },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });

  await notifyEmployee(advance.employeeId, {
    type: 'REQUEST_APPROVED',
    title: `Salary advance ${advance.reference} approved`,
    body: `${advance.currency} ${approvedAmount.toFixed(2)}, repaid in ${input.numberOfInstallments} instalment(s) from ${monthLabel(start)}.`,
    entityType: 'SalaryAdvance',
    entityId: advanceId,
  });

  return serializeAdvance(updated);
}

export async function rejectAdvance(
  auth: AuthContext,
  advanceId: string,
  note: string,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  assertCanDecideAdvance(auth, advance.employee);
  if (advance.status !== 'PENDING') {
    throw new ConflictError(`This advance is already ${advance.status.toLowerCase()}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: { status: 'REJECTED', rejectedById: auth.userId, rejectedAt: new Date(), decisionNote: note },
      include: advanceInclude,
    });
    await recordAudit(
      {
        action: 'REJECT',
        entityType: 'SalaryAdvance',
        entityId: advanceId,
        legalEntityId: advance.legalEntityId,
        summary: `Rejected salary advance ${advance.reference}`,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', note },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });

  await notifyEmployee(advance.employeeId, {
    type: 'REQUEST_REJECTED',
    title: `Salary advance ${advance.reference} was not approved`,
    body: note,
    entityType: 'SalaryAdvance',
    entityId: advanceId,
  });

  return serializeAdvance(updated);
}

/**
 * Withdrawing: the employee while it is still pending, or HR any time before
 * the money has been paid out.
 */
export async function cancelAdvance(auth: AuthContext, advanceId: string, fingerprint: Fingerprint): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  const owner = isSelf(auth, advance.employee);
  const hr = managesEmployee(auth, advance.employee);
  if (!owner && !hr) throw new NotFoundError('Salary advance');
  if (owner && !hr && advance.status !== 'PENDING') {
    throw new ConflictError('Only a pending advance can be withdrawn. Contact HR.');
  }
  if (!['PENDING', 'APPROVED'].includes(advance.status)) {
    throw new ConflictError(`An advance that is ${advance.status.toLowerCase()} cannot be cancelled`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.salaryAdvanceInstallment.updateMany({ where: { advanceId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    const result = await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), remainingAmount: ZERO },
      include: advanceInclude,
    });
    await recordAudit(
      {
        action: 'CANCEL',
        entityType: 'SalaryAdvance',
        entityId: advanceId,
        legalEntityId: advance.legalEntityId,
        summary: `Cancelled salary advance ${advance.reference}`,
        before: { status: advance.status },
        after: { status: 'CANCELLED' },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });
  return serializeAdvance(updated);
}

/** HR records that the money was handed over; repayment through payroll starts. */
export async function markAdvancePaid(
  auth: AuthContext,
  advanceId: string,
  input: z.infer<typeof advancePaymentSchema>,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  assertCanDecideAdvance(auth, advance.employee);
  if (advance.status !== 'APPROVED') {
    throw new ConflictError(`Only an approved advance can be marked as paid; this one is ${advance.status.toLowerCase()}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidById: auth.userId,
        paymentReference: input.paymentReference ?? null,
        decisionNote: input.note ?? advance.decisionNote,
      },
      include: advanceInclude,
    });
    await recordAudit(
      {
        action: 'MARK_PAID',
        entityType: 'SalaryAdvance',
        entityId: advanceId,
        legalEntityId: advance.legalEntityId,
        summary: `Salary advance ${advance.reference} paid out: ${advance.currency} ${advance.approvedAmount?.toFixed(2)}`,
        after: { status: 'PAID', paymentReference: input.paymentReference ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });

  await notifyEmployee(advance.employeeId, {
    type: 'REQUEST_APPROVED',
    title: `Salary advance ${advance.reference} paid`,
    body: 'The advance has been paid. Instalments will be deducted from your salary as scheduled.',
    entityType: 'SalaryAdvance',
    entityId: advanceId,
  });

  return serializeAdvance(updated);
}

/**
 * Changes the plan for what is still owed - "skip December", "spread it over
 * more months". Instalments already deducted by an approved payroll stay as
 * they are; the rest are replaced by a new even split of the remaining amount.
 */
export async function rescheduleAdvance(
  auth: AuthContext,
  advanceId: string,
  input: AdvanceRescheduleInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const advance = await loadAdvance(advanceId);
  assertCanDecideAdvance(auth, advance.employee);
  if (!['APPROVED', 'PAID', 'ACTIVE'].includes(advance.status)) {
    throw new ConflictError(`An advance that is ${advance.status.toLowerCase()} cannot be rescheduled`);
  }

  const settings = await getCompanySettings(advance.legalEntityId);
  if (input.numberOfInstallments > settings.maxAdvanceInstallments) {
    throw new ValidationError('Validation failed', {
      numberOfInstallments: [`Advances are repaid in at most ${settings.maxAdvanceInstallments} instalments`],
    });
  }
  const start = monthStart(input.repaymentStartMonth);
  await assertMonthOpen(advance.legalEntityId, start);

  const deducted = advance.installments.filter((installment) => installment.status === 'DEDUCTED');
  const lastDeducted = deducted.length ? deducted[deducted.length - 1] : undefined;
  if (lastDeducted && start <= lastDeducted.dueMonth) {
    throw new ValidationError('Validation failed', {
      repaymentStartMonth: ['The new plan must start after the last instalment already deducted'],
    });
  }

  const principal = advance.approvedAmount ?? advance.requestedAmount;
  const remaining = principal.minus(sum(deducted.map((installment) => installment.amount)));
  if (remaining.lessThanOrEqualTo(0)) {
    throw new ConflictError('Nothing remains to be repaid on this advance');
  }
  const firstSequence = (advance.installments.reduce((max, installment) => Math.max(max, installment.sequence), 0)) + 1;
  const plan = buildInstallments(remaining, input.numberOfInstallments, start, firstSequence);
  const replaced = advance.installments.filter((installment) => installment.status === 'SCHEDULED');

  const updated = await prisma.$transaction(async (tx) => {
    await tx.salaryAdvanceInstallment.updateMany({
      where: { advanceId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    });
    await tx.salaryAdvanceInstallment.createMany({ data: plan.map((installment) => ({ ...installment, advanceId })) });
    const result = await tx.salaryAdvance.update({
      where: { id: advanceId },
      data: {
        numberOfInstallments: deducted.length + input.numberOfInstallments,
        installmentAmount: plan[0]?.amount ?? remaining,
        remainingAmount: remaining,
      },
      include: advanceInclude,
    });
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'SalaryAdvance',
        entityId: advanceId,
        legalEntityId: advance.legalEntityId,
        summary: `Rescheduled salary advance ${advance.reference}: ${remaining.toFixed(2)} over ${input.numberOfInstallments} instalment(s) from ${input.repaymentStartMonth} (${input.reason})`,
        before: { installments: replaced.map((installment) => `${toDateKey(installment.dueMonth).slice(0, 7)}: ${installment.amount.toFixed(2)}`) },
        after: { installments: plan.map((installment) => `${toDateKey(installment.dueMonth).slice(0, 7)}: ${installment.amount.toFixed(2)}`) },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });

  return serializeAdvance(updated);
}

/** Employee-facing summary for the home screen and profile. */
export async function getAdvanceSummary(auth: AuthContext, employeeId: string): Promise<unknown> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, legalEntityId: true, managerId: true },
  });
  if (!employee) throw new NotFoundError('Employee');
  assertCanViewPayData(auth, employee);

  const advances = await prisma.salaryAdvance.findMany({
    where: { employeeId, status: { in: ['PENDING', 'APPROVED', 'PAID', 'ACTIVE'] } },
    include: advanceInclude,
    orderBy: { requestDate: 'desc' },
  });
  const outstanding = sum(
    advances.filter((advance) => advance.status === 'PAID' || advance.status === 'ACTIVE').map((advance) => advance.remainingAmount),
  );
  return { open: advances.map(serializeAdvance), outstandingAmount: toAmount(outstanding) };
}
