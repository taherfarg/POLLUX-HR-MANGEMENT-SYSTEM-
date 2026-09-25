import { Prisma } from '@prisma/client';
import type { AttendanceDayType, CompanySettings, OvertimeStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanDecideOvertime,
  assertCanManageAttendance,
  canViewOvertimeAmounts,
  entityScopeWhere,
  isManagement,
  type EmployeeAccessSubject,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee } from '../../services/notification.service';
import { getCompanySettings } from '../../services/company';
import { toDateKey } from '../../services/working-days';
import { assertPayrollPeriodOpen, isLockedPayrollItem } from '../../services/payroll-lock';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const overtimeQuerySchema = paginationSchema.extend({
  employeeId: optionalTrimmedString(40),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  myTeamOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const manualOvertimeSchema = z.object({
  employeeId: requiredTrimmedString(1, 40),
  date: dateStringSchema,
  minutes: z.coerce.number().int().min(1).max(16 * 60),
  dayType: z.enum(['WORKING_DAY', 'WEEKEND', 'HOLIDAY']).default('WORKING_DAY'),
  reason: requiredTrimmedString(3, 300),
});

export const overtimeDecisionSchema = z.object({ note: optionalTrimmedString(300) });
export const overtimeRejectionSchema = z.object({ note: requiredTrimmedString(3, 300) });

export type OvertimeQuery = z.infer<typeof overtimeQuerySchema>;
export type ManualOvertimeInput = z.infer<typeof manualOvertimeSchema>;

export function overtimeMultiplier(settings: CompanySettings, dayType: AttendanceDayType): Prisma.Decimal {
  return dayType === 'WORKING_DAY' ? settings.overtimeRateMultiplier : settings.restDayOvertimeMultiplier;
}

/**
 * Keeps the overtime entry of one attendance day in step with its minutes.
 *
 * Called whenever an attendance record is written (check-out, HR correction,
 * recalculation). A change of minutes is a change of basis, so a decided entry
 * goes back to PENDING (or straight to APPROVED where policy does not require
 * approval). An entry already paid through an approved payroll is never
 * touched - that period has to be reopened first.
 */
export async function syncOvertimeFromAttendance(
  tx: TxClient,
  input: {
    record: {
      id: string;
      employeeId: string;
      legalEntityId: string;
      workDate: Date;
      dayType: AttendanceDayType;
      overtimeMinutes: number;
    };
    settings: CompanySettings;
  },
): Promise<void> {
  const { record, settings } = input;
  const existing = await tx.overtimeEntry.findUnique({
    where: { attendanceId: record.id },
    include: { payrollItem: { select: { id: true, record: { select: { period: { select: { status: true } } } } } } },
  });
  const minutes = record.overtimeMinutes;
  const autoStatus: OvertimeStatus = settings.overtimeRequiresApproval ? 'PENDING' : 'APPROVED';
  const autoNote = settings.overtimeRequiresApproval ? null : 'Approved automatically by company policy';

  if (!existing) {
    if (minutes <= 0) return;
    await tx.overtimeEntry.create({
      data: {
        employeeId: record.employeeId,
        legalEntityId: record.legalEntityId,
        attendanceId: record.id,
        date: record.workDate,
        minutes,
        dayType: record.dayType,
        rateMultiplier: overtimeMultiplier(settings, record.dayType),
        status: autoStatus,
        source: 'ATTENDANCE',
        decidedAt: autoStatus === 'APPROVED' ? new Date() : null,
        decisionNote: autoNote,
      },
    });
    return;
  }

  if (isLockedPayrollItem(existing.payrollItem)) return;
  if (existing.minutes === minutes && existing.dayType === record.dayType) return;

  await tx.overtimeEntry.update({
    where: { id: existing.id },
    data:
      minutes <= 0
        ? { minutes: 0, status: 'CANCELLED', decisionNote: 'Cancelled: the attendance no longer shows overtime' }
        : {
            minutes,
            dayType: record.dayType,
            rateMultiplier: overtimeMultiplier(settings, record.dayType),
            status: autoStatus,
            decidedAt: autoStatus === 'APPROVED' ? new Date() : null,
            decidedById: null,
            decisionNote: autoNote ?? 'Minutes changed after an attendance update - awaiting a new decision',
          },
  });
}

const overtimeInclude = {
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
  payrollItem: {
    select: {
      id: true,
      amount: true,
      rate: true,
      record: { select: { period: { select: { id: true, name: true, status: true } } } },
    },
  },
} satisfies Prisma.OvertimeEntryInclude;

type OvertimeRow = Prisma.OvertimeEntryGetPayload<{ include: typeof overtimeInclude }>;

function serializeOvertime(entry: OvertimeRow, auth: AuthContext) {
  const subject: EmployeeAccessSubject = entry.employee;
  // Minutes are working context; the money is pay and follows the pay rule.
  const showAmounts = canViewOvertimeAmounts(auth, subject);
  return {
    id: entry.id,
    date: toDateKey(entry.date),
    minutes: entry.minutes,
    hours: Number((entry.minutes / 60).toFixed(2)),
    dayType: entry.dayType,
    rateMultiplier: Number(entry.rateMultiplier),
    status: entry.status,
    source: entry.source,
    reason: entry.reason,
    attendanceId: entry.attendanceId,
    decidedAt: entry.decidedAt,
    decisionNote: entry.decisionNote,
    employee: {
      id: entry.employee.id,
      employeeNumber: entry.employee.employeeNumber,
      fullName: `${entry.employee.firstName} ${entry.employee.lastName}`,
      jobTitle: entry.employee.jobTitle,
      department: entry.employee.department,
    },
    payroll: entry.payrollItem
      ? {
          period: entry.payrollItem.record.period,
          ...(showAmounts
            ? { amount: Number(entry.payrollItem.amount), rate: entry.payrollItem.rate ? Number(entry.payrollItem.rate) : null }
            : {}),
        }
      : null,
  };
}

function overtimeScope(auth: AuthContext, myTeamOnly: boolean): Prisma.OvertimeEntryWhereInput {
  if (isManagement(auth) && !myTeamOnly) {
    const scope = entityScopeWhere(auth);
    return scope.legalEntityId ? { legalEntityId: scope.legalEntityId as string } : {};
  }
  if (auth.employeeId && (auth.role === 'MANAGER' || myTeamOnly)) {
    return myTeamOnly
      ? { employee: { managerId: auth.employeeId } }
      : { OR: [{ employeeId: auth.employeeId }, { employee: { managerId: auth.employeeId } }] };
  }
  if (auth.employeeId) return { employeeId: auth.employeeId };
  return { id: '__none__' };
}

/** Overtime visible to the caller: own, direct reports' (manager), or all in scope (HR). */
export async function listOvertime(
  auth: AuthContext,
  query: OvertimeQuery,
): Promise<{ items: unknown[]; meta: PageMeta; summary: Record<string, number> }> {
  const filters: Prisma.OvertimeEntryWhereInput[] = [overtimeScope(auth, query.myTeamOnly)];
  if (query.employeeId) filters.push({ employeeId: query.employeeId });
  if (query.status) filters.push({ status: query.status });
  if (query.from) filters.push({ date: { gte: toUtcDate(query.from) } });
  if (query.to) filters.push({ date: { lte: toUtcDate(query.to) } });
  const where: Prisma.OvertimeEntryWhereInput = { AND: filters };

  const { skip, take } = toSkipTake(query);
  const [entries, total, grouped] = await Promise.all([
    prisma.overtimeEntry.findMany({ where, include: overtimeInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip, take }),
    prisma.overtimeEntry.count({ where }),
    prisma.overtimeEntry.groupBy({ by: ['status'], where: { AND: filters.filter((f) => !('status' in f)) }, _count: { _all: true }, _sum: { minutes: true } }),
  ]);

  const summary: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, approvedMinutes: 0, pendingMinutes: 0 };
  for (const row of grouped) {
    summary[row.status] = row._count._all;
    if (row.status === 'APPROVED') summary.approvedMinutes = row._sum.minutes ?? 0;
    if (row.status === 'PENDING') summary.pendingMinutes = row._sum.minutes ?? 0;
  }

  return {
    items: entries.map((entry) => serializeOvertime(entry, auth)),
    meta: buildPageMeta(query.page, query.pageSize, total),
    summary,
  };
}

async function loadEntry(entryId: string): Promise<OvertimeRow> {
  const entry = await prisma.overtimeEntry.findUnique({ where: { id: entryId }, include: overtimeInclude });
  if (!entry) throw new NotFoundError('Overtime entry');
  return entry;
}

/**
 * HR records overtime that attendance could not capture (a site visit, an
 * evening event). HR is the approver, so the entry is created approved - the
 * payroll four-eyes check still reviews it before anyone is paid.
 */
export async function createManualOvertime(
  auth: AuthContext,
  input: ManualOvertimeInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true, hireDate: true, exitDate: true },
  });
  if (!employee) throw new NotFoundError('Employee');
  assertCanManageAttendance(auth, employee);

  const date = toUtcDate(input.date);
  if (date < employee.hireDate || (employee.exitDate && date > employee.exitDate)) {
    throw new ValidationError('Validation failed', { date: ['The employee was not employed on this date'] });
  }
  await assertPayrollPeriodOpen(prisma, employee.legalEntityId, input.date);

  const settings = await getCompanySettings(employee.legalEntityId);
  const created = await prisma.$transaction(async (tx) => {
    const entry = await tx.overtimeEntry.create({
      data: {
        employeeId: employee.id,
        legalEntityId: employee.legalEntityId,
        date,
        minutes: input.minutes,
        dayType: input.dayType,
        rateMultiplier: overtimeMultiplier(settings, input.dayType),
        status: 'APPROVED',
        source: 'MANUAL',
        reason: input.reason,
        createdById: auth.userId,
        decidedById: auth.userId,
        decidedAt: new Date(),
        decisionNote: 'Entered by HR',
      },
      include: overtimeInclude,
    });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'OvertimeEntry',
        entityId: entry.id,
        legalEntityId: employee.legalEntityId,
        summary: `Recorded ${input.minutes} minutes of overtime for ${employee.employeeNumber} on ${input.date}`,
        after: { minutes: input.minutes, dayType: input.dayType, reason: input.reason },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return entry;
  });

  return serializeOvertime(created, auth);
}

async function decide(
  auth: AuthContext,
  entryId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | undefined,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const entry = await loadEntry(entryId);
  assertCanDecideOvertime(auth, entry.employee);
  if (entry.status !== 'PENDING') {
    throw new ConflictError(`This overtime is already ${entry.status.toLowerCase()}`);
  }
  await assertPayrollPeriodOpen(prisma, entry.legalEntityId, toDateKey(entry.date));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.overtimeEntry.update({
      where: { id: entryId },
      data: { status: decision, decidedById: auth.userId, decidedAt: new Date(), decisionNote: note ?? null },
      include: overtimeInclude,
    });
    await recordAudit(
      {
        action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        entityType: 'OvertimeEntry',
        entityId: entryId,
        legalEntityId: entry.legalEntityId,
        summary: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${entry.minutes} minutes of overtime for ${entry.employee.employeeNumber} on ${toDateKey(entry.date)}`,
        before: { status: 'PENDING' },
        after: { status: decision, note: note ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });

  await notifyEmployee(entry.employeeId, {
    type: decision === 'APPROVED' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED',
    title: `Overtime on ${toDateKey(entry.date)} ${decision === 'APPROVED' ? 'approved' : 'not approved'}`,
    body: note ?? `${(entry.minutes / 60).toFixed(1)} hours`,
    entityType: 'OvertimeEntry',
    entityId: entryId,
  });

  return serializeOvertime(updated, auth);
}

export function approveOvertime(auth: AuthContext, entryId: string, note: string | undefined, fingerprint: Fingerprint) {
  return decide(auth, entryId, 'APPROVED', note, fingerprint);
}

export function rejectOvertime(auth: AuthContext, entryId: string, note: string, fingerprint: Fingerprint) {
  return decide(auth, entryId, 'REJECTED', note, fingerprint);
}

/** HR withdraws an entry entered in error. Paid overtime cannot be cancelled. */
export async function cancelOvertime(auth: AuthContext, entryId: string, fingerprint: Fingerprint): Promise<unknown> {
  const entry = await loadEntry(entryId);
  assertCanManageAttendance(auth, entry.employee);
  if (entry.status === 'CANCELLED') throw new ConflictError('This overtime is already cancelled');
  if (isLockedPayrollItem(entry.payrollItem)) {
    throw new ConflictError('This overtime was paid in an approved payroll and cannot be cancelled');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.overtimeEntry.update({
      where: { id: entryId },
      data: { status: 'CANCELLED', decidedById: auth.userId, decidedAt: new Date(), decisionNote: 'Cancelled by HR' },
      include: overtimeInclude,
    });
    await recordAudit(
      {
        action: 'CANCEL',
        entityType: 'OvertimeEntry',
        entityId: entryId,
        legalEntityId: entry.legalEntityId,
        summary: `Cancelled overtime for ${entry.employee.employeeNumber} on ${toDateKey(entry.date)}`,
        before: { status: entry.status },
        after: { status: 'CANCELLED' },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return result;
  });
  return serializeOvertime(updated, auth);
}
