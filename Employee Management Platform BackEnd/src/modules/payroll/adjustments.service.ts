import { Prisma } from '@prisma/client';
import type { PayrollAdjustmentType, PayrollItemKind } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertCanManagePayroll, managesEmployee, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { getCompanySettings } from '../../services/company';
import { assertPayrollPeriodOpen, isLockedPayrollItem } from '../../services/payroll-lock';
import { money, toAmount } from '../../services/money';
import { toDateKey } from '../../services/working-days';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Payroll adjustments: bonuses, commissions, one-off allowances and
 * deductions. Each one is a relational row with its own approval, never a
 * free-form JSON blob on the payroll - so every figure on a payslip can be
 * traced to who entered it and who approved it.
 */

const ADJUSTMENT_TYPES = ['BONUS', 'COMMISSION', 'ALLOWANCE', 'DEDUCTION', 'ABSENCE', 'UNPAID_LEAVE', 'ADVANCE', 'OVERTIME', 'OTHER'] as const;

/** The side of the payslip each type belongs on. OTHER must say. */
const KIND_BY_TYPE: Record<PayrollAdjustmentType, PayrollItemKind | null> = {
  BONUS: 'EARNING',
  COMMISSION: 'EARNING',
  ALLOWANCE: 'EARNING',
  OVERTIME: 'EARNING',
  DEDUCTION: 'DEDUCTION',
  ABSENCE: 'DEDUCTION',
  UNPAID_LEAVE: 'DEDUCTION',
  ADVANCE: 'DEDUCTION',
  OTHER: null,
};

export const adjustmentSchema = z
  .object({
    employeeId: requiredTrimmedString(1, 40),
    payrollMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month such as 2026-09'),
    type: z.enum(ADJUSTMENT_TYPES),
    kind: z.enum(['EARNING', 'DEDUCTION']).optional(),
    description: requiredTrimmedString(3, 200),
    amount: z.coerce.number().positive('Enter an amount above zero').max(10_000_000),
  })
  .refine((value) => value.type !== 'OTHER' || Boolean(value.kind), {
    message: 'Say whether this is an earning or a deduction',
    path: ['kind'],
  });

export const adjustmentQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  employeeId: optionalTrimmedString(40),
  payrollMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  type: z.enum(ADJUSTMENT_TYPES).optional(),
});

export const adjustmentDecisionSchema = z.object({ note: optionalTrimmedString(300) });
export const adjustmentRejectionSchema = z.object({ note: requiredTrimmedString(3, 300) });

export type AdjustmentInput = z.infer<typeof adjustmentSchema>;
export type AdjustmentQuery = z.infer<typeof adjustmentQuerySchema>;

const adjustmentInclude = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      legalEntityId: true,
      managerId: true,
      department: { select: { id: true, name: true } },
    },
  },
  payrollItem: { select: { id: true, record: { select: { period: { select: { id: true, name: true, status: true } } } } } },
} satisfies Prisma.PayrollAdjustmentInclude;

type AdjustmentRow = Prisma.PayrollAdjustmentGetPayload<{ include: typeof adjustmentInclude }>;

function serialize(adjustment: AdjustmentRow) {
  return {
    id: adjustment.id,
    payrollMonth: toDateKey(adjustment.payrollMonth).slice(0, 7),
    type: adjustment.type,
    kind: adjustment.kind,
    description: adjustment.description,
    amount: toAmount(adjustment.amount),
    currency: adjustment.currency,
    status: adjustment.status,
    createdById: adjustment.createdById,
    approvedById: adjustment.approvedById,
    approvedAt: adjustment.approvedAt,
    decisionNote: adjustment.decisionNote,
    createdAt: adjustment.createdAt,
    employee: {
      id: adjustment.employee.id,
      employeeNumber: adjustment.employee.employeeNumber,
      fullName: `${adjustment.employee.firstName} ${adjustment.employee.lastName}`,
      department: adjustment.employee.department,
    },
    payrollPeriod: adjustment.payrollItem?.record.period ?? null,
  };
}

async function loadAdjustment(adjustmentId: string): Promise<AdjustmentRow> {
  const adjustment = await prisma.payrollAdjustment.findUnique({ where: { id: adjustmentId }, include: adjustmentInclude });
  if (!adjustment) throw new NotFoundError('Payroll adjustment');
  return adjustment;
}

function assertManages(auth: AuthContext, adjustment: AdjustmentRow): void {
  assertCanManagePayroll(auth, adjustment.legalEntityId);
  if (!managesEmployee(auth, adjustment.employee)) throw new ForbiddenError('This employee is outside your scope');
}

export async function createAdjustment(auth: AuthContext, input: AdjustmentInput, fingerprint: Fingerprint): Promise<unknown> {
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: {
      id: true,
      legalEntityId: true,
      managerId: true,
      employeeNumber: true,
      legalEntity: { select: { currency: true } },
      compensation: { where: { isCurrent: true }, select: { currency: true }, take: 1 },
    },
  });
  if (!employee) throw new NotFoundError('Employee');
  assertCanManagePayroll(auth, employee.legalEntityId);
  if (!managesEmployee(auth, employee)) throw new ForbiddenError('This employee is outside your scope');

  const payrollMonth = new Date(`${input.payrollMonth}-01T00:00:00.000Z`);
  // A bonus for a month that is already approved goes in a later month instead.
  await assertPayrollPeriodOpen(prisma, employee.legalEntityId, toDateKey(payrollMonth));

  const kind = KIND_BY_TYPE[input.type] ?? (input.kind as PayrollItemKind);
  if (input.kind && KIND_BY_TYPE[input.type] && input.kind !== KIND_BY_TYPE[input.type]) {
    throw new ValidationError('Validation failed', { kind: [`A ${input.type.toLowerCase()} is always ${KIND_BY_TYPE[input.type]?.toLowerCase()}`] });
  }

  const amount = money(input.amount);
  const created = await prisma.$transaction(async (tx) => {
    const adjustment = await tx.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        legalEntityId: employee.legalEntityId,
        payrollMonth,
        type: input.type,
        kind,
        description: input.description,
        amount,
        currency: employee.compensation[0]?.currency ?? employee.legalEntity.currency,
        createdById: auth.userId,
      },
      include: adjustmentInclude,
    });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'PayrollAdjustment',
        entityId: adjustment.id,
        legalEntityId: employee.legalEntityId,
        summary: `Added ${input.type.toLowerCase()} for ${employee.employeeNumber} (${input.payrollMonth}): ${input.description}`,
        after: { type: input.type, kind, amount: amount.toFixed(2), payrollMonth: input.payrollMonth },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return adjustment;
  });
  return serialize(created);
}

export async function listAdjustments(
  auth: AuthContext,
  query: AdjustmentQuery,
): Promise<{ items: unknown[]; meta: PageMeta; summary: Record<string, number> }> {
  const scope = scopedEntityId(auth);
  if (!['ADMIN', 'HR_ADMIN'].includes(auth.role)) {
    throw new ForbiddenError('Payroll adjustments are restricted to HR and administrators');
  }
  const filters: Prisma.PayrollAdjustmentWhereInput[] = [];
  if (scope) filters.push({ legalEntityId: scope });
  if (query.employeeId) filters.push({ employeeId: query.employeeId });
  if (query.payrollMonth) filters.push({ payrollMonth: new Date(`${query.payrollMonth}-01T00:00:00.000Z`) });
  if (query.type) filters.push({ type: query.type });
  const base: Prisma.PayrollAdjustmentWhereInput = filters.length ? { AND: filters } : {};
  const where = query.status ? { AND: [base, { status: query.status }] } : base;

  const { skip, take } = toSkipTake(query);
  const [rows, total, grouped] = await Promise.all([
    prisma.payrollAdjustment.findMany({ where, include: adjustmentInclude, orderBy: [{ payrollMonth: 'desc' }, { createdAt: 'desc' }], skip, take }),
    prisma.payrollAdjustment.count({ where }),
    prisma.payrollAdjustment.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
  ]);
  const summary: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const row of grouped) summary[row.status] = row._count._all;
  return { items: rows.map(serialize), meta: buildPageMeta(query.page, query.pageSize, total), summary };
}

async function decide(
  auth: AuthContext,
  adjustmentId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | undefined,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const adjustment = await loadAdjustment(adjustmentId);
  assertManages(auth, adjustment);
  if (adjustment.status !== 'PENDING') throw new ConflictError(`This adjustment is already ${adjustment.status.toLowerCase()}`);
  if (auth.employeeId && auth.employeeId === adjustment.employeeId) {
    throw new ForbiddenError('You cannot decide an adjustment to your own pay');
  }
  // Four-eyes on money, when the company asks for it: whoever entered an
  // amount does not also approve it.
  const settings = await getCompanySettings(adjustment.legalEntityId);
  if (decision === 'APPROVED' && settings.payrollRequiresSeparateApprover && adjustment.createdById === auth.userId) {
    throw new ForbiddenError('Another HR user or an administrator must approve an adjustment you entered');
  }
  await assertPayrollPeriodOpen(prisma, adjustment.legalEntityId, toDateKey(adjustment.payrollMonth));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.payrollAdjustment.update({
      where: { id: adjustmentId },
      data: { status: decision, approvedById: auth.userId, approvedAt: new Date(), decisionNote: note ?? null },
      include: adjustmentInclude,
    });
    await recordAudit(
      {
        action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        entityType: 'PayrollAdjustment',
        entityId: adjustmentId,
        legalEntityId: adjustment.legalEntityId,
        summary: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${adjustment.type.toLowerCase()} for ${adjustment.employee.employeeNumber}: ${adjustment.description}`,
        before: { status: 'PENDING' },
        after: { status: decision, amount: adjustment.amount.toFixed(2), note: note ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });
  return serialize(updated);
}

export function approveAdjustment(auth: AuthContext, id: string, note: string | undefined, fingerprint: Fingerprint) {
  return decide(auth, id, 'APPROVED', note, fingerprint);
}

export function rejectAdjustment(auth: AuthContext, id: string, note: string, fingerprint: Fingerprint) {
  return decide(auth, id, 'REJECTED', note, fingerprint);
}

export async function cancelAdjustment(auth: AuthContext, adjustmentId: string, fingerprint: Fingerprint): Promise<unknown> {
  const adjustment = await loadAdjustment(adjustmentId);
  assertManages(auth, adjustment);
  if (adjustment.status === 'CANCELLED' || adjustment.status === 'REJECTED') {
    throw new ConflictError(`This adjustment is already ${adjustment.status.toLowerCase()}`);
  }
  if (isLockedPayrollItem(adjustment.payrollItem)) {
    throw new ConflictError('This adjustment was paid in an approved payroll and cannot be cancelled');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.payrollAdjustment.update({
      where: { id: adjustmentId },
      data: { status: 'CANCELLED' },
      include: adjustmentInclude,
    });
    await recordAudit(
      {
        action: 'CANCEL',
        entityType: 'PayrollAdjustment',
        entityId: adjustmentId,
        legalEntityId: adjustment.legalEntityId,
        summary: `Cancelled ${adjustment.type.toLowerCase()} for ${adjustment.employee.employeeNumber}: ${adjustment.description}`,
        before: { status: adjustment.status },
        after: { status: 'CANCELLED' },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });
  return serialize(updated);
}
