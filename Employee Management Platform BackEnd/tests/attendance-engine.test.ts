import { describe, expect, it } from 'vitest';
import {
  evaluateDay,
  leaveDaysByDate,
  planDay,
  type AttendancePolicy,
  type LeaveDay,
} from '../src/modules/attendance/attendance.engine';
import { zonedWallTimeToUtc } from '../src/services/timezone';
import { normaliseScheduleDays, type ResolvedSchedule } from '../src/services/work-context';

/**
 * The attendance rules, exercised directly with fixed instants so every case
 * is deterministic. The standard schedule is Pollux's: Monday to Friday,
 * 09:00-18:00 with a one-hour break, in Dubai.
 */

const DUBAI = 'Asia/Dubai';
const CAIRO = 'Africa/Cairo';

function schedule(timezone: string | null, days: number[] = [1, 2, 3, 4, 5], start = 540, end = 1080, breakMinutes = 60): ResolvedSchedule {
  return {
    id: 'sched',
    name: 'Standard Dubai Office',
    timezone,
    isFallback: false,
    days: normaliseScheduleDays(
      days.map((dayOfWeek) => ({ dayOfWeek, isWorkingDay: true, startMinute: start, endMinute: end, breakMinutes })),
    ),
  };
}

const policy: AttendancePolicy = {
  lateGraceMinutes: 10,
  earlyLeaveGraceMinutes: 10,
  partialDayThresholdPercent: 50,
  missingCheckoutAfterMinutes: 120,
  overtimeEnabled: true,
  minOvertimeMinutes: 30,
  countEarlyArrivalAsOvertime: false,
};

/** An instant at a local wall time. */
const at = (dateKey: string, clock: string, timezone = DUBAI): Date => {
  const [hours, minutes] = clock.split(':').map(Number) as [number, number];
  return zonedWallTimeToUtc(dateKey, hours * 60 + minutes, timezone);
};

// Monday 21 September 2026 is an ordinary working day.
const MONDAY = '2026-09-21';
const SATURDAY = '2026-09-26';

function plan(dateKey: string, options: { timezone?: string; sched?: ResolvedSchedule; holiday?: string; leave?: LeaveDay } = {}) {
  return planDay({
    dateKey,
    timezone: options.timezone ?? DUBAI,
    schedule: options.sched ?? schedule(DUBAI),
    hireDateKey: '2024-01-01',
    exitDateKey: null,
    holiday: options.holiday ? { name: options.holiday, type: 'PUBLIC' } : null,
    leave: options.leave ?? null,
  });
}

function run(
  dayPlan: ReturnType<typeof plan>,
  checkIn: Date | null,
  checkOut: Date | null,
  options: { now?: Date; todayKey?: string; overtimeEligible?: boolean; policy?: Partial<AttendancePolicy> } = {},
) {
  return evaluateDay(
    dayPlan,
    checkIn || checkOut ? { checkIn, checkOut, statusOverride: null } : null,
    { ...policy, ...options.policy },
    {
      overtimeEligible: options.overtimeEligible ?? true,
      now: options.now ?? at('2026-09-25', '12:00'),
      todayKey: options.todayKey ?? '2026-09-25',
    },
  );
}

describe('attendance engine', () => {
  describe('a normal working day', () => {
    it('plans 09:00-18:00 Dubai as 05:00-14:00 UTC with 480 net minutes', () => {
      const day = plan(MONDAY);
      expect(day.dayType).toBe('WORKING_DAY');
      expect(day.scheduledStart?.toISOString()).toBe('2026-09-21T05:00:00.000Z');
      expect(day.scheduledEnd?.toISOString()).toBe('2026-09-21T14:00:00.000Z');
      expect(day.scheduledMinutes).toBe(480);
    });

    it('is PRESENT for an on-time check-in and check-out', () => {
      const result = run(plan(MONDAY), at(MONDAY, '08:55'), at(MONDAY, '18:00'));
      expect(result.status).toBe('PRESENT');
      expect(result.lateMinutes).toBe(0);
      expect(result.earlyLeaveMinutes).toBe(0);
      expect(result.overtimeMinutes).toBe(0);
      // 9h05 on site minus the one-hour break.
      expect(result.workedMinutes).toBe(485);
      expect(result.breakMinutes).toBe(60);
    });
  });

  describe('late arrival', () => {
    it('is not late within the grace period', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:08'), at(MONDAY, '18:00'));
      expect(result.lateMinutes).toBe(0);
      expect(result.status).toBe('PRESENT');
    });

    it('reports the full lateness once past the grace period', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:17'), at(MONDAY, '18:00'));
      expect(result.lateMinutes).toBe(17);
      expect(result.status).toBe('LATE');
    });

    it('matches the brief: 09:17 to 18:45 is 17 minutes late and 45 minutes of overtime', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:17'), at(MONDAY, '18:45'));
      expect(result.lateMinutes).toBe(17);
      expect(result.overtimeMinutes).toBe(45);
      expect(result.workedMinutes).toBe(9 * 60 + 28 - 60);
    });

    it('uses a configurable grace period', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:17'), at(MONDAY, '18:00'), { policy: { lateGraceMinutes: 20 } });
      expect(result.lateMinutes).toBe(0);
    });
  });

  describe('check-out, early leave and partial days', () => {
    it('reports leaving early beyond the grace period', () => {
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '17:30')).earlyLeaveMinutes).toBe(30);
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '17:55')).earlyLeaveMinutes).toBe(0);
    });

    it('is PARTIAL when well short of the scheduled minutes, with no break deducted', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '12:00'));
      expect(result.status).toBe('PARTIAL');
      expect(result.workedMinutes).toBe(180);
      expect(result.breakMinutes).toBe(0);
    });
  });

  describe('overtime', () => {
    it('ignores overtime below the configured minimum', () => {
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '18:20')).overtimeMinutes).toBe(0);
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '18:30')).overtimeMinutes).toBe(30);
    });

    it('counts early arrival only when policy says so', () => {
      expect(run(plan(MONDAY), at(MONDAY, '08:00'), at(MONDAY, '18:00')).overtimeMinutes).toBe(0);
      expect(
        run(plan(MONDAY), at(MONDAY, '08:00'), at(MONDAY, '18:00'), { policy: { countEarlyArrivalAsOvertime: true } })
          .overtimeMinutes,
      ).toBe(60);
    });

    it('gives nothing when overtime is disabled or the employee is not eligible', () => {
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '20:00'), { policy: { overtimeEnabled: false } }).overtimeMinutes).toBe(0);
      expect(run(plan(MONDAY), at(MONDAY, '09:00'), at(MONDAY, '20:00'), { overtimeEligible: false }).overtimeMinutes).toBe(0);
    });
  });

  describe('missing check-out', () => {
    it('stays open during the shift', () => {
      const result = run(plan('2026-09-25'), at('2026-09-25', '09:00'), null, {
        now: at('2026-09-25', '15:00'),
        todayKey: '2026-09-25',
      });
      // Friday is a working day in this schedule.
      expect(result.status).toBe('PRESENT');
      expect(result.isOpen).toBe(true);
      expect(result.elapsedMinutes).toBe(360);
    });

    it('becomes MISSING_CHECKOUT once the shift is overdue by the policy margin', () => {
      const result = run(plan('2026-09-25'), at('2026-09-25', '09:00'), null, {
        now: at('2026-09-25', '20:30'),
        todayKey: '2026-09-25',
      });
      expect(result.status).toBe('MISSING_CHECKOUT');
      expect(result.isOpen).toBe(false);
    });

    it('does not flag evening work that started after the shift ended', () => {
      const result = run(plan('2026-09-25'), at('2026-09-25', '20:45'), null, {
        now: at('2026-09-25', '21:00'),
        todayKey: '2026-09-25',
      });
      // Arriving after the shift ended is late (it is), but still open.
      expect(result.status).not.toBe('MISSING_CHECKOUT');
      expect(result.isOpen).toBe(true);
    });

    it('is MISSING_CHECKOUT for a past day that was never closed', () => {
      const result = run(plan(MONDAY), at(MONDAY, '09:00'), null);
      expect(result.status).toBe('MISSING_CHECKOUT');
      expect(result.workedMinutes).toBe(0);
    });
  });

  describe('days with no check-in', () => {
    it('is ABSENT on a past working day', () => {
      const result = run(plan(MONDAY), null, null);
      expect(result.status).toBe('ABSENT');
      expect(result.absentDays).toBe(1);
    });

    it('is SCHEDULED before the start and NOT_CHECKED_IN after the grace period today', () => {
      const today = plan('2026-09-25');
      expect(run(today, null, null, { now: at('2026-09-25', '08:30') }).status).toBe('SCHEDULED');
      expect(run(today, null, null, { now: at('2026-09-25', '09:30') }).status).toBe('NOT_CHECKED_IN');
      expect(run(today, null, null, { now: at('2026-09-25', '19:00') }).status).toBe('ABSENT');
    });

    it('is SCHEDULED for a future working day', () => {
      expect(run(plan('2026-09-28'), null, null).status).toBe('SCHEDULED');
    });
  });

  describe('weekends and holidays', () => {
    it('is a WEEKEND on a rest day with no work', () => {
      const day = plan(SATURDAY);
      expect(day.dayType).toBe('WEEKEND');
      expect(run(day, null, null, { todayKey: '2026-09-30' }).status).toBe('WEEKEND');
    });

    it('counts every minute worked on a rest day as overtime', () => {
      const result = run(plan(SATURDAY), at(SATURDAY, '10:00'), at(SATURDAY, '14:00'), { todayKey: '2026-09-30' });
      expect(result.status).toBe('PRESENT');
      expect(result.overtimeMinutes).toBe(240);
      expect(result.lateMinutes).toBe(0);
    });

    it('is a HOLIDAY on a public holiday, which is never an absence', () => {
      const day = plan('2026-12-02', { holiday: 'UAE National Day' });
      expect(day.dayType).toBe('HOLIDAY');
      expect(day.holidayName).toBe('UAE National Day');
      const result = run(day, null, null, { todayKey: '2026-12-10' });
      expect(result.status).toBe('HOLIDAY');
      expect(result.absentDays).toBe(0);
    });
  });

  describe('approved leave', () => {
    const fullDay: LeaveDay = { requestId: 'r1', reference: 'LV-1', leaveTypeName: 'Annual Leave', isPaid: true, fraction: 1 };
    const halfDay: LeaveDay = { ...fullDay, fraction: 0.5 };

    it('is ON_LEAVE for a full day of approved leave', () => {
      const day = plan(MONDAY, { leave: fullDay });
      expect(day.dayType).toBe('LEAVE');
      expect(run(day, null, null).status).toBe('ON_LEAVE');
      expect(run(day, null, null).absentDays).toBe(0);
    });

    it('halves the expected time on a half-day leave and does not mark lateness', () => {
      const day = plan(MONDAY, { leave: halfDay });
      expect(day.dayType).toBe('WORKING_DAY');
      expect(day.scheduledMinutes).toBe(240);
      const afternoon = run(day, at(MONDAY, '13:00'), at(MONDAY, '18:00'));
      expect(afternoon.lateMinutes).toBe(0);
      expect(afternoon.status).toBe('PRESENT');
      // Nobody came for the other half: half a day absent.
      expect(run(day, null, null).absentDays).toBe(0.5);
    });

    it('spreads leave over working days only, honouring half days', () => {
      const workingDays = new Set(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
      const map = leaveDaysByDate(
        [
          {
            requestId: 'r1',
            reference: 'LV-1',
            leaveTypeName: 'Annual Leave',
            isPaid: true,
            startKey: '2026-09-24',
            endKey: '2026-09-28',
            halfDayStart: true,
            halfDayEnd: false,
          },
        ],
        (key) => workingDays.has(key) || key === '2026-09-28',
      );
      expect(map.get('2026-09-24')?.fraction).toBe(0.5);
      expect(map.get('2026-09-25')?.fraction).toBe(1);
      expect(map.has('2026-09-26')).toBe(false); // Saturday
      expect(map.has('2026-09-27')).toBe(false); // Sunday
      expect(map.get('2026-09-28')?.fraction).toBe(1);
    });
  });

  describe('timezones', () => {
    it('reads a floating schedule in the employee own zone', () => {
      // "09:00 wherever you are": a Cairo employee checking in at 09:05 Cairo time is on time.
      const cairoDay = plan(MONDAY, { timezone: CAIRO, sched: schedule(null) });
      expect(cairoDay.scheduledStart?.toISOString()).toBe('2026-09-21T06:00:00.000Z'); // Cairo is UTC+3 in September
      const result = run(cairoDay, at(MONDAY, '09:05', CAIRO), at(MONDAY, '18:00', CAIRO));
      expect(result.lateMinutes).toBe(0);
      expect(result.status).toBe('PRESENT');
    });

    it('reads an anchored schedule in the anchor zone', () => {
      // The same 09:05 Cairo check-in against a schedule anchored to Dubai hours
      // (09:00 Dubai = 08:00 Cairo) is 65 minutes late.
      const anchored = plan(MONDAY, { timezone: DUBAI, sched: schedule(DUBAI) });
      const result = run(anchored, at(MONDAY, '09:05', CAIRO), at(MONDAY, '18:00', CAIRO));
      expect(result.lateMinutes).toBe(65);
    });

    it('stays correct across the Cairo daylight-saving change', () => {
      // 24 April 2026: Cairo moves from UTC+2 to UTC+3 at midnight.
      const before = plan('2026-04-23', { timezone: CAIRO, sched: schedule(null) });
      const after = plan('2026-04-24', { timezone: CAIRO, sched: schedule(null, [0, 1, 2, 3, 4, 5, 6]) });
      expect(before.scheduledStart?.toISOString()).toBe('2026-04-23T07:00:00.000Z');
      expect(after.scheduledStart?.toISOString()).toBe('2026-04-24T06:00:00.000Z');
    });
  });

  describe('employment window', () => {
    it('does not count days before the hire date', () => {
      const day = planDay({
        dateKey: MONDAY,
        timezone: DUBAI,
        schedule: schedule(DUBAI),
        hireDateKey: '2026-09-22',
        exitDateKey: null,
        holiday: null,
        leave: null,
      });
      expect(run(day, null, null).status).toBe('NOT_EMPLOYED');
      expect(run(day, null, null).absentDays).toBe(0);
    });
  });
});
