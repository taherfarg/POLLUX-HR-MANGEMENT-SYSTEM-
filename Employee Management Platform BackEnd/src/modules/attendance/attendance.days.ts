import type { AttendanceRecord, CompanySettings } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { toDateKey } from '../../services/working-days';
import { dateKeysInRange, zonedClock, zonedDateKey } from '../../services/timezone';
import { loadHolidayDates, loadWorkContexts, type EmployeeWorkContext, type HolidayEntry } from '../../services/work-context';
import {
  evaluateDay,
  leaveDaysByDate,
  planDay,
  type AttendancePolicy,
  type DayEvaluation,
  type DayPlan,
  type EvaluatedStatus,
  type LeaveDay,
} from './attendance.engine';

/**
 * Loads and evaluates attendance days - the one path every attendance screen,
 * report, dashboard card and payroll calculation goes through, so they can
 * never disagree about what happened on a day.
 *
 * A stored record whose day is complete (checked out, or set by HR) is
 * returned as stored: its figures are a snapshot, and changing a schedule or a
 * grace period does not silently rewrite history (HR can recalculate a range
 * explicitly). Open records and days with no record are evaluated live.
 */

export function attendancePolicy(settings: CompanySettings): AttendancePolicy {
  return {
    lateGraceMinutes: settings.lateGraceMinutes,
    earlyLeaveGraceMinutes: settings.earlyLeaveGraceMinutes,
    partialDayThresholdPercent: settings.partialDayThresholdPercent,
    missingCheckoutAfterMinutes: settings.missingCheckoutAfterMinutes,
    overtimeEnabled: settings.overtimeEnabled,
    minOvertimeMinutes: settings.minOvertimeMinutes,
    countEarlyArrivalAsOvertime: settings.countEarlyArrivalAsOvertime,
  };
}

export interface AttendanceDay {
  context: EmployeeWorkContext;
  plan: DayPlan;
  record: AttendanceRecord | null;
  evaluation: DayEvaluation;
}

export interface LoadedEmployeeDays {
  context: EmployeeWorkContext;
  todayKey: string;
  days: AttendanceDay[];
}

/** Holidays and approved leave for an employee, ready for planning. */
export interface DayInputs {
  holidays: Map<string, HolidayEntry>;
  leaves: Map<string, LeaveDay>;
}

function isScheduledWorkingDay(context: EmployeeWorkContext, dateKey: string): boolean {
  const dayOfWeek = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return context.schedule.days[dayOfWeek]?.isWorkingDay ?? false;
}

/** Holidays and approved leave for many employees over a date range. */
export async function loadDayInputs(
  contexts: EmployeeWorkContext[],
  fromKey: string,
  toKey: string,
  client: TxClient = prisma,
): Promise<Map<string, DayInputs>> {
  const [holidayMaps, leaves] = await Promise.all([
    loadHolidayDates(
      contexts.map((context) => context.holidayCalendarId),
      fromKey,
      toKey,
      client,
    ),
    client.leaveRequestDetail.findMany({
      where: {
        request: { employeeId: { in: contexts.map((context) => context.employeeId) }, status: 'APPROVED' },
        startDate: { lte: new Date(`${toKey}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${fromKey}T00:00:00.000Z`) },
      },
      select: {
        startDate: true,
        endDate: true,
        halfDayStart: true,
        halfDayEnd: true,
        leaveType: { select: { name: true, isPaid: true } },
        request: { select: { id: true, reference: true, employeeId: true } },
      },
    }),
  ]);

  const result = new Map<string, DayInputs>();
  for (const context of contexts) {
    const holidays = (context.holidayCalendarId ? holidayMaps.get(context.holidayCalendarId) : undefined) ?? new Map();
    const own = leaves
      .filter((leave) => leave.request.employeeId === context.employeeId)
      .map((leave) => ({
        requestId: leave.request.id,
        reference: leave.request.reference,
        leaveTypeName: leave.leaveType.name,
        isPaid: leave.leaveType.isPaid,
        startKey: toDateKey(leave.startDate),
        endKey: toDateKey(leave.endDate),
        halfDayStart: leave.halfDayStart,
        halfDayEnd: leave.halfDayEnd,
      }));
    const leaveMap = leaveDaysByDate(own, (dateKey) => isScheduledWorkingDay(context, dateKey) && !holidays.has(dateKey));
    result.set(context.employeeId, { holidays, leaves: leaveMap });
  }
  return result;
}

/** The plan for one day from the employee's *current* schedule, holidays and leave. */
export function freshPlan(context: EmployeeWorkContext, inputs: DayInputs, dateKey: string, timezone?: string): DayPlan {
  return planDay({
    dateKey,
    timezone: timezone ?? context.timezone,
    schedule: context.schedule,
    hireDateKey: context.hireDateKey,
    exitDateKey: context.exitDateKey,
    holiday: inputs.holidays.get(dateKey) ?? null,
    leave: inputs.leaves.get(dateKey) ?? null,
  });
}

/**
 * A stored record carries the schedule that applied when it was created.
 * Re-evaluating it (an open check-in, a check-out) uses that snapshot, not
 * whatever the schedule says today.
 */
export function snapshotPlan(plan: DayPlan, record: AttendanceRecord): DayPlan {
  if (!record.scheduledStart && record.dayType === 'WORKING_DAY') return { ...plan, timezone: record.timezone };
  return {
    ...plan,
    timezone: record.timezone,
    dayType: record.dayType,
    scheduleId: record.scheduleId,
    scheduledStart: record.scheduledStart,
    scheduledEnd: record.scheduledEnd,
    scheduledMinutes: record.scheduledMinutes,
  };
}

/** The evaluation stored on a completed record. */
function storedEvaluation(record: AttendanceRecord): DayEvaluation {
  return {
    status: record.status,
    workedMinutes: record.workedMinutes,
    breakMinutes: record.breakMinutes,
    lateMinutes: record.lateMinutes,
    earlyLeaveMinutes: record.earlyLeaveMinutes,
    overtimeMinutes: record.overtimeMinutes,
    absentDays: Number(record.absentDays),
    isOpen: false,
    elapsedMinutes: 0,
  };
}

/**
 * Whether a missing check-in on this date means anything: not for someone
 * whose attendance is not tracked, and not before the company started
 * tracking attendance at all.
 */
export function isTrackedDay(context: EmployeeWorkContext, dateKey: string): boolean {
  if (!context.attendanceTracked) return false;
  const start = context.settings.attendanceStartDate;
  return !start || dateKey >= toDateKey(start);
}

export function evaluateStoredOrVirtual(
  context: EmployeeWorkContext,
  plan: DayPlan,
  record: AttendanceRecord | null,
  now: Date,
  todayKey: string,
): { plan: DayPlan; evaluation: DayEvaluation } {
  const policy = attendancePolicy(context.settings);
  if (!record) {
    return {
      plan,
      evaluation: evaluateDay(plan, null, policy, {
        overtimeEligible: context.overtimeEligible,
        attendanceTracked: isTrackedDay(context, plan.dateKey),
        now,
        todayKey,
      }),
    };
  }
  const effectivePlan = snapshotPlan(plan, record);
  const isComplete = Boolean(record.checkOut) || (!record.checkIn && record.statusOverridden);
  if (isComplete) {
    return { plan: effectivePlan, evaluation: storedEvaluation(record) };
  }
  return {
    plan: effectivePlan,
    evaluation: evaluateDay(
      effectivePlan,
      { checkIn: record.checkIn, checkOut: record.checkOut, statusOverride: record.statusOverridden ? record.status : null },
      policy,
      { overtimeEligible: context.overtimeEligible, now, todayKey },
    ),
  };
}

/**
 * Every day in `[fromKey, toKey]` for each employee: stored records merged with
 * evaluated days that have no record.
 */
export async function loadAttendanceDays(
  employeeIds: string[],
  fromKey: string,
  toKey: string,
  now: Date = new Date(),
  client: TxClient = prisma,
): Promise<Map<string, LoadedEmployeeDays>> {
  const contextMap = await loadWorkContexts(employeeIds, client);
  const contexts = [...contextMap.values()];
  if (contexts.length === 0) return new Map();

  const [inputs, records] = await Promise.all([
    loadDayInputs(contexts, fromKey, toKey, client),
    client.attendanceRecord.findMany({
      where: {
        employeeId: { in: contexts.map((context) => context.employeeId) },
        workDate: { gte: new Date(`${fromKey}T00:00:00.000Z`), lte: new Date(`${toKey}T00:00:00.000Z`) },
      },
    }),
  ]);

  const recordsByEmployee = new Map<string, Map<string, AttendanceRecord>>();
  for (const record of records) {
    const bucket = recordsByEmployee.get(record.employeeId) ?? new Map<string, AttendanceRecord>();
    bucket.set(toDateKey(record.workDate), record);
    recordsByEmployee.set(record.employeeId, bucket);
  }

  const keys = dateKeysInRange(fromKey, toKey);
  const result = new Map<string, LoadedEmployeeDays>();

  for (const context of contexts) {
    const todayKey = zonedDateKey(now, context.timezone);
    const employeeInputs = inputs.get(context.employeeId) as DayInputs;
    const employeeRecords = recordsByEmployee.get(context.employeeId) ?? new Map<string, AttendanceRecord>();

    const days = keys.map((dateKey) => {
      const record = employeeRecords.get(dateKey) ?? null;
      const plan = freshPlan(context, employeeInputs, dateKey, record?.timezone);
      const evaluated = evaluateStoredOrVirtual(context, plan, record, now, todayKey);
      return { context, plan: evaluated.plan, record, evaluation: evaluated.evaluation };
    });

    result.set(context.employeeId, { context, todayKey, days });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface EmployeeLabel {
  id: string;
  employeeNumber: string;
  fullName: string;
  jobTitle?: string;
  department?: { id: string; name: string } | null;
  workMode?: string;
  workLocation?: { id: string; name: string } | null;
}

export function serializeDay(
  day: AttendanceDay,
  options: { employee?: EmployeeLabel; includeCorrection?: boolean } = {},
): Record<string, unknown> {
  const { plan, record, evaluation } = day;
  const timezone = record?.timezone ?? plan.timezone;
  return {
    id: record?.id ?? null,
    isVirtual: !record,
    date: plan.dateKey,
    dayOfWeek: plan.dayOfWeek,
    dayName: WEEKDAY_NAMES[plan.dayOfWeek],
    timezone,
    dayType: plan.dayType,
    holidayName: plan.holidayName,
    leave: plan.leave
      ? { reference: plan.leave.reference, leaveTypeName: plan.leave.leaveTypeName, fraction: plan.leave.fraction, isPaid: plan.leave.isPaid }
      : null,
    status: evaluation.status,
    isOpen: evaluation.isOpen,
    elapsedMinutes: evaluation.elapsedMinutes,
    checkIn: record?.checkIn ?? null,
    checkOut: record?.checkOut ?? null,
    checkInLocal: zonedClock(record?.checkIn, timezone),
    checkOutLocal: zonedClock(record?.checkOut, timezone),
    scheduledStart: plan.scheduledStart,
    scheduledEnd: plan.scheduledEnd,
    scheduledStartLocal: zonedClock(plan.scheduledStart, timezone),
    scheduledEndLocal: zonedClock(plan.scheduledEnd, timezone),
    scheduledMinutes: plan.scheduledMinutes,
    workedMinutes: evaluation.workedMinutes,
    breakMinutes: evaluation.breakMinutes,
    lateMinutes: evaluation.lateMinutes,
    earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
    overtimeMinutes: evaluation.overtimeMinutes,
    absentDays: evaluation.absentDays,
    source: record?.source ?? null,
    notes: record?.notes ?? null,
    isManual: record?.isManual ?? false,
    statusOverridden: record?.statusOverridden ?? false,
    correction:
      options.includeCorrection && record?.correctedAt
        ? { reason: record.correctionReason, correctedAt: record.correctedAt }
        : null,
    ...(options.employee ? { employee: options.employee } : {}),
  };
}

const PRESENT_STATUSES: EvaluatedStatus[] = ['PRESENT', 'LATE', 'PARTIAL', 'MISSING_CHECKOUT'];

export interface AttendanceTotals {
  days: number;
  scheduledDays: number;
  presentDays: number;
  lateDays: number;
  partialDays: number;
  absentDays: number;
  leaveDays: number;
  holidays: number;
  restDays: number;
  missingCheckouts: number;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
}

/** Totals for a set of days. Only days up to "today" count towards presence and absence. */
export function totalsFor(days: AttendanceDay[]): AttendanceTotals {
  const totals: AttendanceTotals = {
    days: 0,
    scheduledDays: 0,
    presentDays: 0,
    lateDays: 0,
    partialDays: 0,
    absentDays: 0,
    leaveDays: 0,
    holidays: 0,
    restDays: 0,
    missingCheckouts: 0,
    scheduledMinutes: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
  };

  for (const { plan, evaluation } of days) {
    if (evaluation.status === 'NOT_EMPLOYED') continue;
    totals.days += 1;
    if (plan.dayType === 'WORKING_DAY') {
      totals.scheduledDays += 1;
      totals.scheduledMinutes += plan.scheduledMinutes;
    }
    if (PRESENT_STATUSES.includes(evaluation.status)) totals.presentDays += 1;
    if (evaluation.status === 'LATE' || evaluation.lateMinutes > 0) totals.lateDays += 1;
    if (evaluation.status === 'PARTIAL') totals.partialDays += 1;
    if (evaluation.status === 'MISSING_CHECKOUT') totals.missingCheckouts += 1;
    if (plan.dayType === 'LEAVE') totals.leaveDays += 1;
    else if (plan.leave) totals.leaveDays += plan.leave.fraction;
    if (plan.dayType === 'HOLIDAY') totals.holidays += 1;
    if (plan.dayType === 'WEEKEND') totals.restDays += 1;
    totals.absentDays += evaluation.absentDays;
    totals.workedMinutes += evaluation.workedMinutes;
    totals.lateMinutes += evaluation.lateMinutes;
    totals.earlyLeaveMinutes += evaluation.earlyLeaveMinutes;
    totals.overtimeMinutes += evaluation.overtimeMinutes;
  }

  totals.absentDays = Number(totals.absentDays.toFixed(2));
  totals.leaveDays = Number(totals.leaveDays.toFixed(2));
  return totals;
}
