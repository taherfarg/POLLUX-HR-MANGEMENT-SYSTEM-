import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PayFrequency, PayrollPeriod, PayrollStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanManagePayroll,
  assertCanReopenPayroll,
  canViewPayData,
  isManagement,
  isSelf,
  scopedEntityId,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee } from '../../services/notification.service';
import { getCompanySettings, resolveLegalEntityId } from '../../services/company';
import { money, sum, toAmount, ZERO, type Money } from '../../services/money';
import { toDateKey } from '../../services/working-days';
import { loadAttendanceDays } from '../attendance/attendance.days';
import {
  calculatePayroll,
  type AdjustmentInput,
  type CompensationSegment,
  type InstallmentInput,
  type OvertimeInput,
  type PayrollComputation,
  type PayrollInput,
  type PayrollPolicy,
} from './payroll.engine';
import { renderPayslipPdf, type PayslipData } from './payslip.pdf';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const createPeriodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  legalEntityId: optionalTrimmedString(40),
  payDate: dateStringSchema.optional(),
  notes: optionalTrimmedString(500),
});

export const periodQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.enum(['DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID', 'CANCELLED']).optional(),
});

export const reopenSchema = z.object({ reason: requiredTrimmedString(5, 500) });
export const cancelPeriodSchema = z.object({ reason: optionalTrimmedString(500) });
export const markPaidSchema = z.object({
  paidOn: dateStringSchema.optional(),
  paymentReference: optionalTrimmedString(120),
});
export const payslipQuerySchema = z.object({
  periodId: optionalTrimmedString(40),
  employeeId: optionalTrimmedString(40),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type CreatePeriodInput = z.infer<typeof createPeriodSchema>;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function periodName(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function periodBounds(year: number, month: number): { start: Date; end: Date; days: number } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end, days: end.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Gathering the inputs for one period
// ---------------------------------------------------------------------------

interface EmployeeSnapshot {
  id: string;
  employeeNumber: string;
  fullName: string;
  jobTitle: string;
  departmentName: string | null;
  workLocationName: string | null;
}

export interface EmployeePayroll {
  employee: EmployeeSnapshot;
  input: PayrollInput;
  computation: PayrollComputation;
  periodDays: number;
}

export interface GatheredPayroll {
  rows: EmployeePayroll[];
  skipped: { employeeId: string; employeeNumber: string; fullName: string; reason: string }[];
}

/** A configured salary in any pay frequency, as a monthly amount. */
function monthly(amount: Prisma.Decimal, frequency: PayFrequency): Money {
  if (frequency === 'ANNUAL') return amount.dividedBy(12);
  if (frequency === 'BIWEEKLY') return amount.times(26).dividedBy(12);
  return amount;
}

function payrollPolicy(settings: Awaited<ReturnType<typeof getCompanySettings>>): PayrollPolicy {
  return {
    salaryDayBasis: settings.salaryDayBasis,
    deductionBase: settings.deductionBase,
    overtimeBase: settings.overtimeBase,
    standardDailyHours: settings.standardDailyHours,
    absenceDeductionEnabled: settings.absenceDeductionEnabled,
    unpaidLeaveDeductionEnabled: settings.unpaidLeaveDeductionEnabled,
    lateDeductionEnabled: settings.lateDeductionEnabled,
  };
}

/**
 * Everything the calculation needs for every employee in the period, read in a
 * fixed number of queries.
 *
 * Only *unpaid* sources are picked up: approved overtime up to the end of the
 * period, approved adjustments for this month or earlier, and instalments due
 * this month or earlier on advances that have actually been paid out. Anything
 * already consumed by an approved payroll is linked to it and excluded, so
 * nothing is ever paid or deducted twice. Absence is counted only for days that
 * have finished.
 */
export async function gatherPayroll(period: PayrollPeriod, now: Date, client: TxClient = prisma): Promise<GatheredPayroll> {
  const startKey = toDateKey(period.startDate);
  const endKey = toDateKey(period.endDate);
  const periodDays = period.endDate.getUTCDate();

  const employees = await client.employee.findMany({
    where: {
      legalEntityId: period.legalEntityId,
      hireDate: { lte: period.endDate },
      OR: [{ exitDate: null }, { exitDate: { gte: period.startDate } }],
    },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      hireDate: true,
      exitDate: true,
      department: { select: { name: true } },
      workLocation: { select: { name: true } },
      compensation: {
        where: { effectiveFrom: { lte: period.endDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startDate } }] },
        orderBy: { effectiveFrom: 'asc' },
      },
    },
    orderBy: { employeeNumber: 'asc' },
  });
  const ids = employees.map((employee) => employee.id);
  const settings = await getCompanySettings(period.legalEntityId, client);
  const policy = payrollPolicy(settings);

  const [attendance, overtime, adjustments, installments] = await Promise.all([
    loadAttendanceDays(ids, startKey, endKey, now, client),
    client.overtimeEntry.findMany({
      where: { employeeId: { in: ids }, status: 'APPROVED', payrollItemId: null, date: { lte: period.endDate } },
      select: { id: true, employeeId: true, date: true, minutes: true, rateMultiplier: true },
    }),
    client.payrollAdjustment.findMany({
      where: { employeeId: { in: ids }, status: 'APPROVED', payrollItemId: null, payrollMonth: { lte: period.startDate } },
      select: { id: true, employeeId: true, type: true, kind: true, description: true, amount: true, currency: true, payrollMonth: true },
    }),
    client.salaryAdvanceInstallment.findMany({
      where: {
        status: 'SCHEDULED',
        payrollItemId: null,
        dueMonth: { lte: period.startDate },
        advance: { employeeId: { in: ids }, status: { in: ['PAID', 'ACTIVE'] } },
      },
      select: {
        id: true,
        sequence: true,
        amount: true,
        dueMonth: true,
        advance: { select: { employeeId: true, reference: true, numberOfInstallments: true, currency: true } },
      },
      orderBy: [{ dueMonth: 'asc' }, { sequence: 'asc' }],
    }),
  ]);

  const rows: EmployeePayroll[] = [];
  const skipped: GatheredPayroll['skipped'] = [];

  for (const employee of employees) {
    const fullName = `${employee.firstName} ${employee.lastName}`;
    const skip = (reason: string) => skipped.push({ employeeId: employee.id, employeeNumber: employee.employeeNumber, fullName, reason });

    const hireKey = toDateKey(employee.hireDate);
    const exitKey = employee.exitDate ? toDateKey(employee.exitDate) : null;
    const employedFrom = hireKey > startKey ? hireKey : startKey;
    const employedTo = exitKey && exitKey < endKey ? exitKey : endKey;

    const foreign = employee.compensation.find((record) => record.currency !== period.currency);
    if (foreign) {
      // Never convert currencies silently - that needs a rate the platform does not have.
      skip(`Salary is recorded in ${foreign.currency}; this payroll runs in ${period.currency}`);
      continue;
    }

    const segments: CompensationSegment[] = [];
    for (const record of employee.compensation) {
      const effectiveFrom = toDateKey(record.effectiveFrom);
      const effectiveTo = record.effectiveTo ? toDateKey(record.effectiveTo) : employedTo;
      const fromKey = effectiveFrom > employedFrom ? effectiveFrom : employedFrom;
      const toKey = effectiveTo < employedTo ? effectiveTo : employedTo;
      if (fromKey > toKey) continue;
      segments.push({
        compensationRecordId: record.id,
        fromKey,
        toKey,
        baseSalary: monthly(record.baseSalary, record.payFrequency),
        housingAllowance: monthly(record.housingAllowance, record.payFrequency),
        transportAllowance: monthly(record.transportAllowance, record.payFrequency),
        otherAllowances: monthly(record.otherAllowances, record.payFrequency),
      });
    }
    if (segments.length === 0) {
      skip('No salary is recorded for this period');
      continue;
    }

    const loaded = attendance.get(employee.id);
    const days = loaded?.days ?? [];
    const todayKey = loaded?.todayKey ?? toDateKey(now);
    const employedDaysList = days.filter((day) => day.plan.isEmployed);
    const isWorking = (type: string) => type === 'WORKING_DAY' || type === 'LEAVE';

    const unpaidLeave = sum(
      employedDaysList.filter((day) => day.plan.leave && !day.plan.leave.isPaid).map((day) => money(day.plan.leave?.fraction ?? 0)),
    );
    const finished = employedDaysList.filter((day) => day.plan.dateKey < todayKey || Boolean(day.record?.checkOut));

    const input: PayrollInput = {
      periodDays,
      employedDays: employedDaysList.length,
      periodWorkingDays: days.filter((day) => isWorking(day.plan.dayType)).length,
      employedWorkingDays: employedDaysList.filter((day) => isWorking(day.plan.dayType)).length,
      segments,
      absentDays: sum(finished.filter((day) => day.plan.dateKey < todayKey).map((day) => money(day.evaluation.absentDays))),
      unpaidLeaveDays: unpaidLeave,
      lateMinutes: finished.reduce((total, day) => total + day.evaluation.lateMinutes, 0),
      overtime: overtime
        .filter((entry) => entry.employeeId === employee.id)
        .map<OvertimeInput>((entry) => ({ id: entry.id, dateKey: toDateKey(entry.date), minutes: entry.minutes, multiplier: entry.rateMultiplier })),
      adjustments: adjustments
        .filter((adjustment) => adjustment.employeeId === employee.id && adjustment.currency === period.currency)
        .map<AdjustmentInput>((adjustment) => {
          const month = toDateKey(adjustment.payrollMonth).slice(0, 7);
          const late = adjustment.payrollMonth < period.startDate;
          return {
            id: adjustment.id,
            type: adjustment.type,
            kind: adjustment.kind,
            description: late ? `${adjustment.description} (for ${month})` : adjustment.description,
            amount: adjustment.amount,
          };
        }),
      installments: installments
        .filter((installment) => installment.advance.employeeId === employee.id && installment.advance.currency === period.currency)
        .map<InstallmentInput>((installment) => ({
          id: installment.id,
          label: `Salary advance ${installment.advance.reference} (${installment.sequence}/${installment.advance.numberOfInstallments ?? installment.sequence})`,
          amount: installment.amount,
        })),
    };

    rows.push({
      employee: {
        id: employee.id,
        employeeNumber: employee.employeeNumber,
        fullName,
        jobTitle: employee.jobTitle,
        departmentName: employee.department?.name ?? null,
        workLocationName: employee.workLocation?.name ?? null,
      },
      input,
      computation: calculatePayroll(input, policy),
      periodDays,
    });
  }

  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const recordInclude = {
  items: { orderBy: { sortOrder: 'asc' } },
  period: { select: { id: true, name: true, year: true, month: true, status: true, startDate: true, endDate: true, payDate: true, legalEntityId: true } },
} satisfies Prisma.PayrollRecordInclude;

type RecordRow = Prisma.PayrollRecordGetPayload<{ include: typeof recordInclude }>;

function serializeRecord(record: Omit<RecordRow, 'items'> & { items?: RecordRow['items'] }) {
  return {
    id: record.id,
    period: {
      id: record.period.id,
      name: record.period.name,
      year: record.period.year,
      month: record.period.month,
      status: record.period.status,
      startDate: toDateKey(record.period.startDate),
      endDate: toDateKey(record.period.endDate),
      payDate: record.period.payDate ? toDateKey(record.period.payDate) : null,
    },
    employee: {
      id: record.employeeId,
      employeeNumber: record.employeeNumber,
      fullName: record.employeeName,
      jobTitle: record.jobTitle,
      departmentName: record.departmentName,
      workLocationName: record.workLocationName,
    },
    currency: record.currency,
    salary: {
      baseSalary: toAmount(record.baseSalary),
      housingAllowance: toAmount(record.housingAllowance),
      transportAllowance: toAmount(record.transportAllowance),
      otherAllowances: toAmount(record.otherAllowances),
    },
    periodDays: record.periodDays,
    employedFraction: Number(record.employedFraction),
    workingDays: record.workingDays,
    absentDays: Number(record.absentDays),
    unpaidLeaveDays: Number(record.unpaidLeaveDays),
    lateMinutes: record.lateMinutes,
    overtimeMinutes: record.overtimeMinutes,
    dailyRate: Number(record.dailyRate),
    hourlyRate: Number(record.hourlyRate),
    grossEarnings: toAmount(record.grossEarnings),
    totalDeductions: toAmount(record.totalDeductions),
    netSalary: toAmount(record.netSalary),
    warnings: record.warnings,
    payslipDocumentId: record.payslipDocumentId,
    hasPayslip: Boolean(record.payslipDocumentId),
    ...(record.items
      ? {
          items: record.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            type: item.type,
            label: item.label,
            quantity: item.quantity === null ? null : Number(item.quantity),
            rate: item.rate === null ? null : Number(item.rate),
            amount: toAmount(item.amount),
            sourceType: item.sourceType,
            sourceId: item.sourceId,
          })),
        }
      : {}),
  };
}

function serializePeriod(period: PayrollPeriod) {
  return {
    id: period.id,
    legalEntityId: period.legalEntityId,
    year: period.year,
    month: period.month,
    name: period.name,
    startDate: toDateKey(period.startDate),
    endDate: toDateKey(period.endDate),
    payDate: period.payDate ? toDateKey(period.payDate) : null,
    currency: period.currency,
    status: period.status,
    employeeCount: period.employeeCount,
    totalGross: toAmount(period.totalGross),
    totalDeductions: toAmount(period.totalDeductions),
    totalNet: toAmount(period.totalNet),
    notes: period.notes,
    calculatedAt: period.calculatedAt,
    calculatedById: period.calculatedById,
    reviewedAt: period.reviewedAt,
    reviewedById: period.reviewedById,
    approvedAt: period.approvedAt,
    approvedById: period.approvedById,
    paidAt: period.paidAt,
    paymentReference: period.paymentReference,
    cancelledAt: period.cancelledAt,
    reopenedAt: period.reopenedAt,
    reopenReason: period.reopenReason,
    reopenCount: period.reopenCount,
    isLocked: period.status === 'APPROVED' || period.status === 'PAID',
  };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

async function loadPeriod(periodId: string, client: TxClient = prisma): Promise<PayrollPeriod> {
  const period = await client.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new NotFoundError('Payroll period');
  return period;
}

function assertStatus(period: PayrollPeriod, allowed: PayrollStatus[], action: string): void {
  if (!allowed.includes(period.status)) {
    throw new ConflictError(`Cannot ${action} a payroll that is ${period.status.toLowerCase()}`);
  }
}

export async function listPeriods(auth: AuthContext, query: z.infer<typeof periodQuerySchema>): Promise<unknown[]> {
  if (!isManagement(auth)) throw new ForbiddenError('Payroll is restricted to HR and administrators');
  const scope = scopedEntityId(auth);
  const periods = await prisma.payrollPeriod.findMany({
    where: {
      ...(scope ? { legalEntityId: scope } : {}),
      ...(query.year ? { year: query.year } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  return periods.map(serializePeriod);
}

export async function createPeriod(auth: AuthContext, input: CreatePeriodInput, fingerprint: Fingerprint): Promise<unknown> {
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertCanManagePayroll(auth, legalEntityId);

  const entity = await prisma.legalEntity.findUniqueOrThrow({ where: { id: legalEntityId }, select: { currency: true } });
  const settings = await getCompanySettings(legalEntityId);
  const { start, end, days } = periodBounds(input.year, input.month);
  const payDate = input.payDate
    ? toUtcDate(input.payDate)
    : new Date(Date.UTC(input.year, input.month - 1, Math.min(settings.payrollDay, days)));

  const existing = await prisma.payrollPeriod.findUnique({
    where: { legalEntityId_year_month: { legalEntityId, year: input.year, month: input.month } },
  });
  if (existing && existing.status !== 'CANCELLED') {
    throw new ConflictError(`A payroll for ${existing.name} already exists (${existing.status.toLowerCase()})`);
  }

  const period = await prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.payrollPeriod.update({
          // A cancelled month can be started again rather than blocking it forever.
          where: { id: existing.id },
          data: {
            status: 'DRAFT',
            payDate,
            notes: input.notes ?? null,
            employeeCount: 0,
            totalGross: ZERO,
            totalDeductions: ZERO,
            totalNet: ZERO,
            cancelledAt: null,
            cancelledById: null,
            calculatedAt: null,
            calculatedById: null,
            reviewedAt: null,
            reviewedById: null,
            records: { deleteMany: {} },
          },
        })
      : await tx.payrollPeriod.create({
          data: {
            legalEntityId,
            year: input.year,
            month: input.month,
            name: periodName(input.year, input.month),
            startDate: start,
            endDate: end,
            payDate,
            currency: entity.currency,
            notes: input.notes ?? null,
            createdById: auth.userId,
          },
        });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'PayrollPeriod',
        entityId: saved.id,
        legalEntityId,
        summary: `${existing ? 'Restarted' : 'Created'} payroll for ${saved.name}`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });

  return serializePeriod(period);
}

/**
 * The register: every employee's totals for the period. It shows everyone's
 * pay, so opening it is itself recorded in the audit trail.
 */
export async function getPeriod(auth: AuthContext, periodId: string, fingerprint: Fingerprint): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);

  const records = await prisma.payrollRecord.findMany({
    where: { periodId },
    include: { period: recordInclude.period },
    orderBy: { employeeNumber: 'asc' },
  });

  if (records.length > 0) {
    await recordAudit({
      action: 'VIEW_SENSITIVE',
      entityType: 'PayrollPeriod',
      entityId: periodId,
      legalEntityId: period.legalEntityId,
      summary: `Viewed the payroll register for ${period.name}`,
      actor: auth,
      ...fingerprint,
    });
  }

  return { ...serializePeriod(period), records: records.map((record) => serializeRecord(record)) };
}

/**
 * Writes one record per employee. A recalculation updates each employee's
 * record in place - its id survives, so a link to it stays valid - and
 * replaces its lines; employees no longer in the payroll lose their record.
 */
async function writeRecords(tx: TxClient, period: PayrollPeriod, gathered: GatheredPayroll): Promise<{ gross: Money; deductions: Money; net: Money }> {
  await tx.payrollRecord.deleteMany({
    where: { periodId: period.id, employeeId: { notIn: gathered.rows.map((row) => row.employee.id) } },
  });
  await tx.payrollItem.deleteMany({ where: { record: { periodId: period.id } } });

  for (const row of gathered.rows) {
    const { computation, input, employee } = row;
    const data = {
      employeeNumber: employee.employeeNumber,
      employeeName: employee.fullName,
      jobTitle: employee.jobTitle,
      departmentName: employee.departmentName,
      workLocationName: employee.workLocationName,
      currency: period.currency,
      compensationRecordId: computation.current.compensationRecordId,
      baseSalary: computation.current.baseSalary.toDecimalPlaces(2),
      housingAllowance: computation.current.housingAllowance.toDecimalPlaces(2),
      transportAllowance: computation.current.transportAllowance.toDecimalPlaces(2),
      otherAllowances: computation.current.otherAllowances.toDecimalPlaces(2),
      periodDays: row.periodDays,
      employedFraction: computation.employedFraction.toDecimalPlaces(4),
      workingDays: input.employedWorkingDays,
      absentDays: input.absentDays,
      unpaidLeaveDays: input.unpaidLeaveDays,
      lateMinutes: input.lateMinutes,
      overtimeMinutes: computation.overtimeMinutes,
      dailyRate: computation.dailyRate,
      hourlyRate: computation.hourlyRate,
      grossEarnings: computation.grossEarnings,
      totalDeductions: computation.totalDeductions,
      netSalary: computation.netSalary,
      warnings: computation.warnings,
      items: {
        create: computation.lines.map((line) => ({
          kind: line.kind,
          type: line.type,
          label: line.label,
          quantity: line.quantity,
          rate: line.rate,
          amount: line.amount,
          sortOrder: line.sortOrder,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
        })),
      },
    } satisfies Prisma.PayrollRecordUpdateWithoutPeriodInput;

    await tx.payrollRecord.upsert({
      where: { periodId_employeeId: { periodId: period.id, employeeId: employee.id } },
      update: data,
      create: { ...data, periodId: period.id, employeeId: employee.id },
    });
  }

  return {
    gross: sum(gathered.rows.map((row) => row.computation.grossEarnings)),
    deductions: sum(gathered.rows.map((row) => row.computation.totalDeductions)),
    net: sum(gathered.rows.map((row) => row.computation.netSalary)),
  };
}

/**
 * Generates (or regenerates) the payroll. Allowed until the period is
 * approved; recalculating a reviewed payroll sends it back for review.
 */
export async function calculatePeriod(
  auth: AuthContext,
  periodId: string,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);
  assertStatus(period, ['DRAFT', 'CALCULATED', 'REVIEWED'], 'calculate');

  const gathered = await gatherPayroll(period, now);

  const updated = await prisma.$transaction(async (tx) => {
    const totals = await writeRecords(tx, period, gathered);
    const saved = await tx.payrollPeriod.update({
      where: { id: periodId },
      data: {
        status: 'CALCULATED',
        employeeCount: gathered.rows.length,
        totalGross: totals.gross,
        totalDeductions: totals.deductions,
        totalNet: totals.net,
        calculatedAt: now,
        calculatedById: auth.userId,
        reviewedAt: null,
        reviewedById: null,
      },
    });
    await recordAudit(
      {
        action: 'CALCULATE',
        entityType: 'PayrollPeriod',
        entityId: periodId,
        legalEntityId: period.legalEntityId,
        summary: `Calculated payroll for ${period.name}: ${gathered.rows.length} employee(s), net ${period.currency} ${totals.net.toFixed(2)}`,
        before: { status: period.status, totalNet: period.totalNet.toFixed(2) },
        after: {
          status: 'CALCULATED',
          employees: gathered.rows.length,
          totalGross: totals.gross.toFixed(2),
          totalDeductions: totals.deductions.toFixed(2),
          totalNet: totals.net.toFixed(2),
          skipped: gathered.skipped.map((entry) => `${entry.employeeNumber}: ${entry.reason}`),
        },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });

  return {
    ...serializePeriod(updated),
    skipped: gathered.skipped,
    warnings: gathered.rows
      .filter((row) => row.computation.warnings.length > 0)
      .map((row) => ({ employeeNumber: row.employee.employeeNumber, fullName: row.employee.fullName, warnings: row.computation.warnings })),
  };
}

export async function reviewPeriod(auth: AuthContext, periodId: string, fingerprint: Fingerprint): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);
  assertStatus(period, ['CALCULATED'], 'review');

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.payrollPeriod.update({
      where: { id: periodId },
      data: { status: 'REVIEWED', reviewedAt: new Date(), reviewedById: auth.userId },
    });
    await recordAudit(
      {
        action: 'REVIEW',
        entityType: 'PayrollPeriod',
        entityId: periodId,
        legalEntityId: period.legalEntityId,
        summary: `Reviewed payroll for ${period.name}`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });
  return serializePeriod(updated);
}

/** Proves the stored payroll still matches its inputs before money is committed. */
async function assertUnchangedSinceCalculation(period: PayrollPeriod, now: Date): Promise<void> {
  const [stored, fresh] = await Promise.all([
    prisma.payrollRecord.findMany({ where: { periodId: period.id }, include: { items: true } }),
    gatherPayroll(period, now),
  ]);

  const storedById = new Map(stored.map((record) => [record.employeeId, record]));
  const changed: string[] = [];

  for (const row of fresh.rows) {
    const record = storedById.get(row.employee.id);
    const sources = (lines: { sourceType: string | null; sourceId: string | null }[]) =>
      lines
        .filter((line) => line.sourceId)
        .map((line) => `${line.sourceType}:${line.sourceId}`)
        .sort()
        .join('|');
    if (
      !record ||
      !record.netSalary.equals(row.computation.netSalary) ||
      !record.grossEarnings.equals(row.computation.grossEarnings) ||
      !record.totalDeductions.equals(row.computation.totalDeductions) ||
      sources(record.items) !== sources(row.computation.lines)
    ) {
      changed.push(row.employee.fullName);
    }
    storedById.delete(row.employee.id);
  }
  for (const record of storedById.values()) changed.push(record.employeeName);

  if (changed.length > 0) {
    throw new ConflictError(
      `The inputs for ${changed.length} employee(s) changed after this payroll was calculated (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}). Recalculate and review it again before approving.`,
      { changedEmployees: changed },
    );
  }
}

async function buildPayslipData(tx: TxClient, record: RecordRow): Promise<PayslipData> {
  const entity = await tx.legalEntity.findUniqueOrThrow({
    where: { id: record.period.legalEntityId },
    select: { legalName: true, addressLine: true, city: true, countryName: true, registrationNumber: true },
  });
  return {
    company: entity,
    period: {
      name: record.period.name,
      startDate: toDateKey(record.period.startDate),
      endDate: toDateKey(record.period.endDate),
      payDate: record.period.payDate ? toDateKey(record.period.payDate) : null,
      status: 'APPROVED',
    },
    employee: {
      name: record.employeeName,
      number: record.employeeNumber,
      jobTitle: record.jobTitle,
      department: record.departmentName,
      workLocation: record.workLocationName,
    },
    currency: record.currency,
    earnings: record.items.filter((item) => item.kind === 'EARNING').map((item) => ({ label: item.label, amount: item.amount })),
    deductions: record.items.filter((item) => item.kind === 'DEDUCTION').map((item) => ({ label: item.label, amount: item.amount })),
    grossEarnings: record.grossEarnings,
    totalDeductions: record.totalDeductions,
    netSalary: record.netSalary,
    attendance: {
      workingDays: record.workingDays,
      absentDays: record.absentDays.toString(),
      unpaidLeaveDays: record.unpaidLeaveDays.toString(),
      overtimeHours: (record.overtimeMinutes / 60).toFixed(2),
    },
    reference: record.id,
    generatedAt: new Date(),
  };
}

/** Links every source row to the payroll line that pays it, refusing any already paid. */
async function linkSources(tx: TxClient, records: RecordRow[], now: Date): Promise<void> {
  for (const record of records) {
    for (const item of record.items) {
      if (!item.sourceId || !item.sourceType) continue;

      if (item.sourceType === 'OvertimeEntry') {
        const linked = await tx.overtimeEntry.updateMany({
          where: { id: item.sourceId, payrollItemId: null, status: 'APPROVED' },
          data: { payrollItemId: item.id },
        });
        if (linked.count !== 1) throw new ConflictError(`Overtime on ${record.employeeName}'s payslip is no longer payable. Recalculate the payroll.`);
      } else if (item.sourceType === 'PayrollAdjustment') {
        const linked = await tx.payrollAdjustment.updateMany({
          where: { id: item.sourceId, payrollItemId: null, status: 'APPROVED' },
          data: { payrollItemId: item.id },
        });
        if (linked.count !== 1) throw new ConflictError(`An adjustment on ${record.employeeName}'s payslip is no longer payable. Recalculate the payroll.`);
      } else if (item.sourceType === 'SalaryAdvanceInstallment') {
        const linked = await tx.salaryAdvanceInstallment.updateMany({
          where: { id: item.sourceId, payrollItemId: null, status: 'SCHEDULED' },
          data: { payrollItemId: item.id, status: 'DEDUCTED', deductedAt: now },
        });
        if (linked.count !== 1) throw new ConflictError(`An advance instalment on ${record.employeeName}'s payslip is no longer due. Recalculate the payroll.`);
        const installment = await tx.salaryAdvanceInstallment.findUniqueOrThrow({
          where: { id: item.sourceId },
          select: { advanceId: true, amount: true },
        });
        const advance = await tx.salaryAdvance.update({
          where: { id: installment.advanceId },
          data: { remainingAmount: { decrement: installment.amount } },
          select: { remainingAmount: true },
        });
        const completed = advance.remainingAmount.lessThanOrEqualTo(0);
        await tx.salaryAdvance.update({
          where: { id: installment.advanceId },
          data: completed
            ? { status: 'COMPLETED', completedAt: now, remainingAmount: ZERO }
            : { status: 'ACTIVE' },
        });
      }
    }
  }
}

/** Reverses linkSources for a reopened period. */
async function unlinkSources(tx: TxClient, periodId: string): Promise<void> {
  const items = await tx.payrollItem.findMany({
    where: { record: { periodId }, sourceId: { not: null } },
    select: { id: true, sourceType: true },
  });
  const itemIds = items.map((item) => item.id);

  await tx.overtimeEntry.updateMany({ where: { payrollItemId: { in: itemIds } }, data: { payrollItemId: null } });
  await tx.payrollAdjustment.updateMany({ where: { payrollItemId: { in: itemIds } }, data: { payrollItemId: null } });

  const installments = await tx.salaryAdvanceInstallment.findMany({
    where: { payrollItemId: { in: itemIds } },
    select: { id: true, advanceId: true, amount: true },
  });
  for (const installment of installments) {
    await tx.salaryAdvanceInstallment.update({
      where: { id: installment.id },
      data: { status: 'SCHEDULED', deductedAt: null, payrollItemId: null },
    });
    await tx.salaryAdvance.update({
      where: { id: installment.advanceId },
      data: { remainingAmount: { increment: installment.amount }, completedAt: null },
    });
  }
  // Each affected advance goes back to PAID when nothing is deducted any more.
  for (const advanceId of new Set(installments.map((installment) => installment.advanceId))) {
    const stillDeducted = await tx.salaryAdvanceInstallment.count({ where: { advanceId, status: 'DEDUCTED' } });
    await tx.salaryAdvance.update({ where: { id: advanceId }, data: { status: stillDeducted > 0 ? 'ACTIVE' : 'PAID' } });
  }
}

/**
 * Approves the payroll: the figures become final.
 *
 * Refused unless the period was reviewed, the approver is not the person who
 * calculated it (when the company requires four eyes), no net salary is
 * negative, and a fresh calculation matches what was reviewed. Then, in one
 * transaction: every overtime entry, instalment and adjustment on it is linked
 * to its payslip line (and instalments reduce what is owed), a PDF payslip is
 * generated and stored as each employee's document, and the period locks.
 */
export async function approvePeriod(
  auth: AuthContext,
  periodId: string,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);
  assertStatus(period, ['REVIEWED'], 'approve');

  const settings = await getCompanySettings(period.legalEntityId);
  if (settings.payrollRequiresSeparateApprover && period.calculatedById === auth.userId) {
    throw new ForbiddenError('The person who calculated this payroll cannot also approve it');
  }
  const negative = await prisma.payrollRecord.findMany({
    where: { periodId, netSalary: { lt: 0 } },
    select: { employeeName: true },
  });
  if (negative.length > 0) {
    throw new ConflictError(`Net salary is negative for ${negative.map((row) => row.employeeName).join(', ')}. Adjust before approving.`);
  }

  await assertUnchangedSinceCalculation(period, now);

  const { updated, employeeIds } = await prisma.$transaction(
    async (tx) => {
      const records = await tx.payrollRecord.findMany({ where: { periodId }, include: recordInclude });
      await linkSources(tx, records, now);

      for (const record of records) {
        const pdf = await renderPayslipPdf(await buildPayslipData(tx, record));
        const fileName = `payslip-${record.period.year}-${String(record.period.month).padStart(2, '0')}-${record.employeeNumber}.pdf`;
        const document = await tx.document.create({
          data: {
            employeeId: record.employeeId,
            category: 'PAYSLIP',
            title: `Payslip ${record.period.name}`,
            fileName,
            fileUrl: `/api/v1/payslips/${record.id}/pdf`,
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
            issuedOn: now,
            isConfidential: false,
            uploadedById: auth.userId,
            file: {
              create: {
                data: new Uint8Array(pdf),
                mimeType: 'application/pdf',
                sizeBytes: pdf.length,
                sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
              },
            },
          },
        });
        await tx.payrollRecord.update({ where: { id: record.id }, data: { payslipDocumentId: document.id } });
      }

      const saved = await tx.payrollPeriod.update({
        where: { id: periodId },
        data: { status: 'APPROVED', approvedAt: now, approvedById: auth.userId },
      });
      await recordAudit(
        {
          action: 'APPROVE',
          entityType: 'PayrollPeriod',
          entityId: periodId,
          legalEntityId: period.legalEntityId,
          summary: `Approved payroll for ${period.name}: ${records.length} payslip(s), net ${period.currency} ${period.totalNet.toFixed(2)}`,
          before: { status: 'REVIEWED' },
          after: { status: 'APPROVED', totalNet: period.totalNet.toFixed(2), payslips: records.length },
          actor: auth,
          ...fingerprint,
        },
        tx,
      );
      return { updated: saved, employeeIds: records.map((record) => record.employeeId) };
    },
    { timeout: 60_000 },
  );

  for (const employeeId of employeeIds) {
    await notifyEmployee(employeeId, {
      type: 'PAYSLIP_ISSUED',
      title: `Your payslip for ${period.name} is ready`,
      body: 'You can view and download it from My pay.',
      entityType: 'PayrollPeriod',
      entityId: periodId,
    });
  }

  return serializePeriod(updated);
}

export async function markPeriodPaid(
  auth: AuthContext,
  periodId: string,
  input: z.infer<typeof markPaidSchema>,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);
  assertStatus(period, ['APPROVED'], 'mark as paid');

  const paidAt = input.paidOn ? toUtcDate(input.paidOn) : new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.payrollPeriod.update({
      where: { id: periodId },
      data: { status: 'PAID', paidAt, paidById: auth.userId, paymentReference: input.paymentReference ?? null },
    });
    await recordAudit(
      {
        action: 'MARK_PAID',
        entityType: 'PayrollPeriod',
        entityId: periodId,
        legalEntityId: period.legalEntityId,
        summary: `Marked payroll for ${period.name} as paid (${period.currency} ${period.totalNet.toFixed(2)})`,
        after: { status: 'PAID', paidOn: toDateKey(paidAt), paymentReference: input.paymentReference ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });
  return serializePeriod(updated);
}

/**
 * The explicit correction path for an approved payroll: an administrator
 * reopens it with a reason. Everything approval did is undone in one
 * transaction - sources unlinked, instalments owed again, payslips withdrawn -
 * and the period goes back to CALCULATED for recalculation and review.
 * A PAID payroll is final: corrections go into the next month as adjustments.
 */
export async function reopenPeriod(
  auth: AuthContext,
  periodId: string,
  reason: string,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanReopenPayroll(auth, period.legalEntityId);
  if (period.status === 'PAID') {
    throw new ConflictError('A paid payroll is final. Record any correction as an adjustment in the next payroll.');
  }
  assertStatus(period, ['APPROVED'], 'reopen');

  const updated = await prisma.$transaction(async (tx) => {
    await unlinkSources(tx, periodId);
    const payslips = await tx.payrollRecord.findMany({
      where: { periodId, payslipDocumentId: { not: null } },
      select: { payslipDocumentId: true },
    });
    await tx.document.deleteMany({
      where: { id: { in: payslips.map((row) => row.payslipDocumentId).filter((id): id is string => Boolean(id)) } },
    });
    const saved = await tx.payrollPeriod.update({
      where: { id: periodId },
      data: {
        status: 'CALCULATED',
        approvedAt: null,
        approvedById: null,
        reviewedAt: null,
        reviewedById: null,
        reopenedAt: new Date(),
        reopenedById: auth.userId,
        reopenReason: reason,
        reopenCount: { increment: 1 },
      },
    });
    await recordAudit(
      {
        action: 'REOPEN',
        entityType: 'PayrollPeriod',
        entityId: periodId,
        legalEntityId: period.legalEntityId,
        summary: `Reopened approved payroll for ${period.name}: ${reason}`,
        before: { status: 'APPROVED', totalNet: period.totalNet.toFixed(2) },
        after: { status: 'CALCULATED', payslipsWithdrawn: payslips.length },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });
  return serializePeriod(updated);
}

export async function cancelPeriod(
  auth: AuthContext,
  periodId: string,
  reason: string | undefined,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const period = await loadPeriod(periodId);
  assertCanManagePayroll(auth, period.legalEntityId);
  assertStatus(period, ['DRAFT', 'CALCULATED', 'REVIEWED'], 'cancel');

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.payrollPeriod.update({
      where: { id: periodId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: auth.userId },
    });
    await recordAudit(
      {
        action: 'CANCEL',
        entityType: 'PayrollPeriod',
        entityId: periodId,
        legalEntityId: period.legalEntityId,
        summary: `Cancelled payroll for ${period.name}${reason ? `: ${reason}` : ''}`,
        before: { status: period.status },
        after: { status: 'CANCELLED' },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });
  return serializePeriod(updated);
}

// ---------------------------------------------------------------------------
// Records and payslips
// ---------------------------------------------------------------------------

const RELEASED: PayrollStatus[] = ['APPROVED', 'PAID'];

async function loadRecord(recordId: string): Promise<RecordRow & { employee: { id: string; legalEntityId: string; managerId: string | null } }> {
  const record = await prisma.payrollRecord.findUnique({
    where: { id: recordId },
    include: { ...recordInclude, employee: { select: { id: true, legalEntityId: true, managerId: true } } },
  });
  if (!record) throw new NotFoundError('Payroll record');
  return record;
}

/**
 * One employee's payroll line. HR in scope may read any; the employee may read
 * their own once it is approved - never a draft. Anyone else gets a 404.
 */
export async function getRecord(auth: AuthContext, recordId: string, fingerprint: Fingerprint): Promise<unknown> {
  const record = await loadRecord(recordId);
  const own = isSelf(auth, record.employee);
  const hr = isManagement(auth) && canViewPayData(auth, record.employee);
  if (!hr && !(own && RELEASED.includes(record.period.status))) {
    throw new NotFoundError('Payroll record');
  }
  if (!own) {
    await recordAudit({
      action: 'VIEW_SENSITIVE',
      entityType: 'PayrollRecord',
      entityId: recordId,
      legalEntityId: record.employee.legalEntityId,
      summary: `Viewed ${record.period.name} payroll for ${record.employeeNumber}`,
      actor: auth,
      ...fingerprint,
    });
  }
  return serializeRecord(record);
}

/** Payslips: the caller's own, or - for HR - anyone's in scope. Only approved or paid months. */
export async function listPayslips(auth: AuthContext, query: z.infer<typeof payslipQuerySchema>): Promise<unknown[]> {
  const filters: Prisma.PayrollRecordWhereInput[] = [{ period: { status: { in: RELEASED } } }];
  if (isManagement(auth)) {
    const scope = scopedEntityId(auth);
    if (scope) filters.push({ period: { legalEntityId: scope } });
    if (query.employeeId) filters.push({ employeeId: query.employeeId });
  } else if (auth.employeeId) {
    filters.push({ employeeId: auth.employeeId });
  } else {
    return [];
  }
  if (query.periodId) filters.push({ periodId: query.periodId });
  if (query.year) filters.push({ period: { year: query.year } });

  const records = await prisma.payrollRecord.findMany({
    where: { AND: filters },
    include: { period: recordInclude.period },
    orderBy: [{ period: { year: 'desc' } }, { period: { month: 'desc' } }, { employeeNumber: 'asc' }],
  });
  return records.map((record) => serializeRecord(record));
}

/** The stored PDF - the bytes generated at approval, never re-rendered from live data. */
export async function getPayslipPdf(
  auth: AuthContext,
  recordId: string,
  fingerprint: Fingerprint,
): Promise<{ fileName: string; data: Buffer }> {
  const record = await loadRecord(recordId);
  const own = isSelf(auth, record.employee);
  const hr = isManagement(auth) && canViewPayData(auth, record.employee);
  if (!hr && !own) throw new NotFoundError('Payslip');
  if (!RELEASED.includes(record.period.status) || !record.payslipDocumentId) {
    throw new NotFoundError('Payslip');
  }
  const document = await prisma.document.findUnique({
    where: { id: record.payslipDocumentId },
    select: { fileName: true, file: { select: { data: true } } },
  });
  if (!document?.file) throw new NotFoundError('Payslip');

  if (!own) {
    await recordAudit({
      action: 'VIEW_SENSITIVE',
      entityType: 'PayrollRecord',
      entityId: recordId,
      legalEntityId: record.employee.legalEntityId,
      summary: `Downloaded the ${record.period.name} payslip of ${record.employeeNumber}`,
      actor: auth,
      ...fingerprint,
    });
  }
  return { fileName: document.fileName, data: Buffer.from(document.file.data) };
}
