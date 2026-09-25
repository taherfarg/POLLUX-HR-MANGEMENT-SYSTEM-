import type { AttendanceDayType, AttendanceStatus } from '@prisma/client';
import {
  dayOfWeekForDateKey,
  minutesBetween,
  zonedWallTimeToUtc,
} from '../../services/timezone';
import type { HolidayEntry, ResolvedSchedule } from '../../services/work-context';

/**
 * The attendance rules, as pure functions.
 *
 * Nothing here touches the database or the clock: the caller passes the
 * schedule, holidays, leave, the recorded times and "now". That is what makes
 * every rule directly testable - late by 17 minutes, 45 minutes of overtime,
 * absent on a working day, a check-in in Cairo read against a Cairo schedule.
 *
 * Evaluation happens in two steps:
 *
 *   planDay      what the day was *supposed* to be: working day, weekend,
 *                holiday or leave, and the scheduled start/end as UTC instants
 *   evaluateDay  what *happened*, given the check-in/out (if any) and policy
 */

/**
 * Statuses the evaluator can return. The first eight are persisted; the others
 * only ever describe a day with no stored record:
 *   SCHEDULED       a working day that has not started yet (or not due yet)
 *   NOT_CHECKED_IN  today, past start + grace, and no check-in so far
 *   NOT_EMPLOYED    before the hire date or after the exit date
 *   NOT_TRACKED     a working day for someone whose attendance is not tracked
 */
export type EvaluatedStatus = AttendanceStatus | 'SCHEDULED' | 'NOT_CHECKED_IN' | 'NOT_EMPLOYED' | 'NOT_TRACKED';

export interface AttendancePolicy {
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  partialDayThresholdPercent: number;
  missingCheckoutAfterMinutes: number;
  overtimeEnabled: boolean;
  minOvertimeMinutes: number;
  countEarlyArrivalAsOvertime: boolean;
}

export interface LeaveDay {
  requestId: string;
  reference: string;
  leaveTypeName: string;
  isPaid: boolean;
  /** 1 for a full day, 0.5 for a half day. */
  fraction: number;
}

export interface DayPlan {
  dateKey: string;
  dayOfWeek: number;
  timezone: string;
  dayType: AttendanceDayType;
  isEmployed: boolean;
  holidayName: string | null;
  leave: LeaveDay | null;
  /** Half the day is approved leave: late/early rules do not apply. */
  halfLeave: boolean;
  scheduleId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** Net scheduled minutes (span minus break), halved on a half-leave day. */
  scheduledMinutes: number;
  /** Break deducted from a full working day. */
  breakMinutes: number;
  /** Break applied to long work on a rest day. */
  restDayBreakMinutes: number;
}

export interface DayFacts {
  checkIn: Date | null;
  checkOut: Date | null;
  /** HR-set status, when the record's status is overridden. */
  statusOverride: AttendanceStatus | null;
}

export interface DayEvaluation {
  status: EvaluatedStatus;
  workedMinutes: number;
  /** Break actually deducted from worked time. */
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  absentDays: number;
  /** Checked in, not yet checked out, and not yet overdue. */
  isOpen: boolean;
  /** Minutes elapsed since check-in for an open day - display only. */
  elapsedMinutes: number;
}

/** Work on a rest day longer than this gets the schedule's usual break deducted. */
export const REST_DAY_BREAK_AFTER_MINUTES = 6 * 60;

/**
 * A check-out is accepted against a check-in at most this long ago. It is a
 * guard against pairing today's check-out with a forgotten check-in from days
 * ago, not a business policy.
 */
export const MAX_SHIFT_MINUTES = 20 * 60;

/** Builds the plan for one employee and one local calendar date. */
export function planDay(input: {
  dateKey: string;
  timezone: string;
  schedule: ResolvedSchedule;
  hireDateKey: string;
  exitDateKey: string | null;
  holiday: HolidayEntry | null;
  leave: LeaveDay | null;
}): DayPlan {
  const dayOfWeek = dayOfWeekForDateKey(input.dateKey);
  const day = input.schedule.days[dayOfWeek];
  const isScheduledDay = Boolean(day?.isWorkingDay && day.startMinute !== null && day.endMinute !== null);
  const isEmployed =
    input.dateKey >= input.hireDateKey && (input.exitDateKey === null || input.dateKey <= input.exitDateKey);

  // A holiday takes precedence (a holiday that falls on a weekend shows as the
  // holiday). Full-day leave only applies to a working day - leave never
  // "consumes" a weekend or a holiday.
  const dayType: AttendanceDayType = input.holiday
    ? 'HOLIDAY'
    : !isScheduledDay
      ? 'WEEKEND'
      : input.leave && input.leave.fraction >= 1
        ? 'LEAVE'
        : 'WORKING_DAY';

  const typicalBreak = input.schedule.days.find((candidate) => candidate.isWorkingDay)?.breakMinutes ?? 0;

  if (dayType !== 'WORKING_DAY' || !day || day.startMinute === null || day.endMinute === null) {
    return {
      dateKey: input.dateKey,
      dayOfWeek,
      timezone: input.timezone,
      dayType,
      isEmployed,
      holidayName: input.holiday?.name ?? null,
      leave: dayType === 'LEAVE' ? input.leave : null,
      halfLeave: false,
      scheduleId: input.schedule.id,
      scheduledStart: null,
      scheduledEnd: null,
      scheduledMinutes: 0,
      breakMinutes: 0,
      restDayBreakMinutes: typicalBreak,
    };
  }

  const halfLeave = Boolean(input.leave && input.leave.fraction > 0 && input.leave.fraction < 1);
  const netMinutes = Math.max(0, day.endMinute - day.startMinute - day.breakMinutes);

  return {
    dateKey: input.dateKey,
    dayOfWeek,
    timezone: input.timezone,
    dayType,
    isEmployed,
    holidayName: null,
    leave: halfLeave ? input.leave : null,
    halfLeave,
    scheduleId: input.schedule.id,
    scheduledStart: zonedWallTimeToUtc(input.dateKey, day.startMinute, input.timezone),
    scheduledEnd: zonedWallTimeToUtc(input.dateKey, day.endMinute, input.timezone),
    scheduledMinutes: halfLeave ? Math.round(netMinutes / 2) : netMinutes,
    breakMinutes: day.breakMinutes,
    restDayBreakMinutes: typicalBreak,
  };
}

const EMPTY: Omit<DayEvaluation, 'status'> = {
  workedMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  absentDays: 0,
  isOpen: false,
  elapsedMinutes: 0,
};

/**
 * Evaluates one day.
 *
 * The rules, in the order they are applied:
 *
 *  - Late: minutes after the scheduled start. Within the grace period it is
 *    not late at all; beyond it the *full* lateness is reported (09:17 against
 *    09:00 with 10 minutes' grace is 17 minutes late, not 7).
 *  - Early leave: the same rule against the scheduled end.
 *  - Worked: check-out minus check-in, less the break - but only when the day
 *    was long enough to have taken one (at least half the scheduled span).
 *  - Overtime on a working day: minutes after the scheduled end (arriving late
 *    does not cancel it - 09:17 to 18:45 is 45 minutes of overtime), plus early
 *    arrival when policy counts it. On a rest day every worked minute is
 *    overtime. Below the policy minimum it is ignored.
 *  - Status: PARTIAL when well short of the scheduled minutes, otherwise LATE
 *    when late, otherwise PRESENT. An open check-in becomes MISSING_CHECKOUT
 *    once the shift is overdue by the policy margin, or the day has passed.
 *  - No check-in on a past working day is ABSENT (half a day when the other
 *    half was approved leave).
 */
export function evaluateDay(
  plan: DayPlan,
  facts: DayFacts | null,
  policy: AttendancePolicy,
  options: { overtimeEligible: boolean; now: Date; todayKey: string; attendanceTracked?: boolean },
): DayEvaluation {
  if (!plan.isEmployed) {
    return { ...EMPTY, status: 'NOT_EMPLOYED' };
  }

  const override = facts?.statusOverride ?? null;
  const checkIn = facts?.checkIn ?? null;
  const checkOut = facts?.checkOut ?? null;
  const isWorkingDay = plan.dayType === 'WORKING_DAY';
  const fullDayAbsence = plan.halfLeave ? 0.5 : 1;

  // --- No check-in ----------------------------------------------------------
  if (!checkIn) {
    if (override) {
      return { ...EMPTY, status: override, absentDays: override === 'ABSENT' && isWorkingDay ? fullDayAbsence : 0 };
    }
    if (plan.dayType === 'HOLIDAY') return { ...EMPTY, status: 'HOLIDAY' };
    if (plan.dayType === 'WEEKEND') return { ...EMPTY, status: 'WEEKEND' };
    if (plan.dayType === 'LEAVE') return { ...EMPTY, status: 'ON_LEAVE' };
    // Someone who does not check in cannot be absent for not checking in.
    if (options.attendanceTracked === false) return { ...EMPTY, status: 'NOT_TRACKED' };

    if (plan.dateKey > options.todayKey) return { ...EMPTY, status: 'SCHEDULED' };
    if (plan.dateKey === options.todayKey) {
      const dueAt = plan.scheduledStart ? plan.scheduledStart.getTime() + policy.lateGraceMinutes * 60_000 : Infinity;
      if (options.now.getTime() < dueAt) return { ...EMPTY, status: 'SCHEDULED' };
      // Past the end of the shift with no check-in, today already counts as absent.
      if (plan.scheduledEnd && options.now.getTime() > plan.scheduledEnd.getTime()) {
        return { ...EMPTY, status: 'ABSENT', absentDays: fullDayAbsence };
      }
      return { ...EMPTY, status: 'NOT_CHECKED_IN' };
    }
    return { ...EMPTY, status: 'ABSENT', absentDays: fullDayAbsence };
  }

  // --- Checked in -----------------------------------------------------------
  let lateMinutes = 0;
  if (isWorkingDay && !plan.halfLeave && plan.scheduledStart && checkIn > plan.scheduledStart) {
    const raw = minutesBetween(plan.scheduledStart, checkIn);
    lateMinutes = raw > policy.lateGraceMinutes ? raw : 0;
  }

  if (!checkOut) {
    const elapsedMinutes = minutesBetween(checkIn, options.now);
    // Overdue relative to the shift only when the check-in was made during the
    // shift; someone who starts evening work after the shift has ended is not
    // "missing a check-out" the moment they arrive.
    const overdueByShift =
      plan.scheduledEnd !== null &&
      checkIn <= plan.scheduledEnd &&
      options.now.getTime() > plan.scheduledEnd.getTime() + policy.missingCheckoutAfterMinutes * 60_000;
    const missing = plan.dateKey < options.todayKey || overdueByShift || elapsedMinutes > MAX_SHIFT_MINUTES;
    const status: EvaluatedStatus = override ?? (missing ? 'MISSING_CHECKOUT' : lateMinutes > 0 ? 'LATE' : 'PRESENT');
    return { ...EMPTY, status, lateMinutes, isOpen: !missing, elapsedMinutes: missing ? 0 : elapsedMinutes };
  }

  const rawSpan = minutesBetween(checkIn, checkOut);
  let breakMinutes = 0;
  if (isWorkingDay) {
    const grossSpan =
      plan.scheduledStart && plan.scheduledEnd ? minutesBetween(plan.scheduledStart, plan.scheduledEnd) : 0;
    if (plan.breakMinutes > 0 && rawSpan > plan.breakMinutes && rawSpan >= grossSpan / 2) {
      breakMinutes = plan.breakMinutes;
    }
  } else if (plan.restDayBreakMinutes > 0 && rawSpan >= REST_DAY_BREAK_AFTER_MINUTES) {
    breakMinutes = plan.restDayBreakMinutes;
  }
  const workedMinutes = Math.max(0, rawSpan - breakMinutes);

  let earlyLeaveMinutes = 0;
  if (isWorkingDay && !plan.halfLeave && plan.scheduledEnd && checkOut < plan.scheduledEnd) {
    const raw = minutesBetween(checkOut, plan.scheduledEnd);
    earlyLeaveMinutes = raw > policy.earlyLeaveGraceMinutes ? raw : 0;
  }

  let overtimeMinutes = 0;
  if (policy.overtimeEnabled && options.overtimeEligible) {
    if (!isWorkingDay) {
      overtimeMinutes = workedMinutes;
    } else if (plan.halfLeave) {
      overtimeMinutes = Math.max(0, workedMinutes - plan.scheduledMinutes);
    } else {
      if (plan.scheduledEnd && checkOut > plan.scheduledEnd) {
        overtimeMinutes += minutesBetween(plan.scheduledEnd, checkOut);
      }
      if (policy.countEarlyArrivalAsOvertime && plan.scheduledStart && checkIn < plan.scheduledStart) {
        overtimeMinutes += minutesBetween(checkIn, plan.scheduledStart);
      }
    }
    if (overtimeMinutes < policy.minOvertimeMinutes) overtimeMinutes = 0;
  }

  let status: EvaluatedStatus;
  if (override) {
    status = override;
  } else if (!isWorkingDay) {
    status = 'PRESENT';
  } else if (plan.scheduledMinutes > 0 && workedMinutes < (plan.scheduledMinutes * policy.partialDayThresholdPercent) / 100) {
    status = 'PARTIAL';
  } else if (lateMinutes > 0) {
    status = 'LATE';
  } else {
    status = 'PRESENT';
  }

  return {
    status,
    workedMinutes,
    breakMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeMinutes,
    absentDays: status === 'ABSENT' && isWorkingDay ? fullDayAbsence : 0,
    isOpen: false,
    elapsedMinutes: 0,
  };
}

/** The persisted form of a status: virtual statuses never reach the database. */
export function persistableStatus(status: EvaluatedStatus): AttendanceStatus {
  switch (status) {
    case 'SCHEDULED':
    case 'NOT_CHECKED_IN':
    case 'NOT_EMPLOYED':
    case 'NOT_TRACKED':
      return 'PRESENT';
    default:
      return status;
  }
}

/**
 * Spreads approved leave over individual dates, with the same half-day rule as
 * the leave balance arithmetic: only working days are charged, a single-day
 * request with a half flag is half a day, and the first/last day of a longer
 * request can each be a half day.
 */
export function leaveDaysByDate(
  leaves: {
    requestId: string;
    reference: string;
    leaveTypeName: string;
    isPaid: boolean;
    startKey: string;
    endKey: string;
    halfDayStart: boolean;
    halfDayEnd: boolean;
  }[],
  isChargeableDay: (dateKey: string) => boolean,
): Map<string, LeaveDay> {
  const result = new Map<string, LeaveDay>();
  for (const leave of leaves) {
    const singleDay = leave.startKey === leave.endKey;
    for (let key = leave.startKey; key <= leave.endKey; key = nextKey(key)) {
      if (!isChargeableDay(key)) continue;
      let fraction = 1;
      if (singleDay) {
        fraction = leave.halfDayStart || leave.halfDayEnd ? 0.5 : 1;
      } else if ((key === leave.startKey && leave.halfDayStart) || (key === leave.endKey && leave.halfDayEnd)) {
        fraction = 0.5;
      }
      result.set(key, {
        requestId: leave.requestId,
        reference: leave.reference,
        leaveTypeName: leave.leaveTypeName,
        isPaid: leave.isPaid,
        fraction,
      });
    }
  }
  return result;
}

function nextKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
