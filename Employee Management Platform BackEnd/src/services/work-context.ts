import type { CompanySettings, HolidayType } from '@prisma/client';
import { prisma, type TxClient } from '../db/prisma';
import { NotFoundError } from '../common/errors';
import { toDateKey } from './working-days';
import { getCompanySettingsMap } from './company';

/**
 * "When and where does this person work?" - resolved once, used everywhere.
 *
 * Attendance, leave arithmetic and payroll all need the same three answers for
 * an employee: their weekly schedule, their timezone and their holiday
 * calendar. Each has a fallback chain ending at the legal entity, so an
 * employee with nothing assigned behaves exactly as they did before Pollux
 * added schedules and calendars:
 *
 *   schedule  = employee schedule  -> company default schedule -> entity work week
 *   timezone  = employee timezone  -> work location timezone    -> entity timezone
 *   calendar  = employee calendar  -> company default calendar  -> entity's first calendar
 *
 * The timezone the *schedule* is read in is the schedule's own anchor zone when
 * it has one ("09:00 Dubai time"), otherwise the employee's zone ("09:00 local").
 */

export interface ScheduleDay {
  dayOfWeek: number;
  isWorkingDay: boolean;
  startMinute: number | null;
  endMinute: number | null;
  breakMinutes: number;
}

export interface ResolvedSchedule {
  id: string | null;
  name: string;
  /** Anchor zone; null means "read in the employee's own zone". */
  timezone: string | null;
  /** Indexed by day of week, 0 = Sunday. Always seven entries. */
  days: ScheduleDay[];
  /** True when synthesised from the entity work week because nothing is assigned. */
  isFallback: boolean;
}

export interface EmployeeWorkContext {
  employeeId: string;
  legalEntityId: string;
  employeeNumber: string;
  fullName: string;
  departmentId: string | null;
  managerId: string | null;
  hireDateKey: string;
  exitDateKey: string | null;
  /** Where the employee is. */
  employeeTimezone: string;
  /** The zone attendance dates and schedule times are evaluated in. */
  timezone: string;
  schedule: ResolvedSchedule;
  /** Working days of the week, derived from the schedule. */
  workWeek: number[];
  holidayCalendarId: string | null;
  overtimeEligible: boolean;
  settings: CompanySettings;
}

const DEFAULT_START_MINUTE = 9 * 60;
const DEFAULT_BREAK_MINUTES = 60;

/**
 * The schedule an employee gets when none is assigned anywhere: the entity's
 * working days, starting 09:00, long enough to cover the entity's weekly hours
 * plus a one-hour break. For a 40-hour, five-day week that is 09:00-18:00.
 */
export function fallbackSchedule(workWeek: number[], weeklyHours: number): ResolvedSchedule {
  const workingDays = workWeek.length || 5;
  const dailyMinutes = Math.round((weeklyHours / workingDays) * 60) || 8 * 60;
  const days: ScheduleDay[] = Array.from({ length: 7 }, (_, dayOfWeek) => {
    const isWorkingDay = workWeek.includes(dayOfWeek);
    return {
      dayOfWeek,
      isWorkingDay,
      startMinute: isWorkingDay ? DEFAULT_START_MINUTE : null,
      endMinute: isWorkingDay ? DEFAULT_START_MINUTE + dailyMinutes + DEFAULT_BREAK_MINUTES : null,
      breakMinutes: isWorkingDay ? DEFAULT_BREAK_MINUTES : 0,
    };
  });
  return { id: null, name: 'Company working week', timezone: null, days, isFallback: true };
}

export function normaliseScheduleDays(
  rows: { dayOfWeek: number; isWorkingDay: boolean; startMinute: number | null; endMinute: number | null; breakMinutes: number }[],
): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const row = rows.find((candidate) => candidate.dayOfWeek === dayOfWeek);
    if (!row || !row.isWorkingDay || row.startMinute === null || row.endMinute === null) {
      return { dayOfWeek, isWorkingDay: false, startMinute: null, endMinute: null, breakMinutes: 0 };
    }
    return {
      dayOfWeek,
      isWorkingDay: true,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      breakMinutes: row.breakMinutes,
    };
  });
}

/** Net scheduled minutes on a day: span minus break, never negative. */
export function scheduledMinutesFor(day: ScheduleDay): number {
  if (!day.isWorkingDay || day.startMinute === null || day.endMinute === null) return 0;
  return Math.max(0, day.endMinute - day.startMinute - day.breakMinutes);
}

const employeeContextSelect = {
  id: true,
  legalEntityId: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  departmentId: true,
  managerId: true,
  hireDate: true,
  exitDate: true,
  timezone: true,
  holidayCalendarId: true,
  overtimeEligible: true,
  workLocation: { select: { timezone: true } },
  workSchedule: { include: { days: true } },
  legalEntity: { select: { timezone: true, workWeek: true, weeklyHours: true } },
} as const;

/** Loads the work context for many employees in a fixed number of queries. */
export async function loadWorkContexts(
  employeeIds: string[],
  client: TxClient = prisma,
): Promise<Map<string, EmployeeWorkContext>> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return new Map();

  const employees = await client.employee.findMany({ where: { id: { in: ids } }, select: employeeContextSelect });
  const entityIds = [...new Set(employees.map((employee) => employee.legalEntityId))];

  const settingsByEntity = await getCompanySettingsMap(entityIds, client);

  const defaultScheduleIds = [...settingsByEntity.values()]
    .map((settings) => settings.defaultWorkScheduleId)
    .filter((id): id is string => Boolean(id));

  const [defaultSchedules, firstCalendars] = await Promise.all([
    defaultScheduleIds.length
      ? client.workSchedule.findMany({ where: { id: { in: defaultScheduleIds } }, include: { days: true } })
      : Promise.resolve([]),
    client.holidayCalendar.findMany({
      where: { legalEntityId: { in: entityIds } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, legalEntityId: true },
    }),
  ]);

  const scheduleById = new Map(defaultSchedules.map((schedule) => [schedule.id, schedule]));
  const firstCalendarByEntity = new Map<string, string>();
  for (const calendar of firstCalendars) {
    if (!firstCalendarByEntity.has(calendar.legalEntityId)) firstCalendarByEntity.set(calendar.legalEntityId, calendar.id);
  }

  const contexts = new Map<string, EmployeeWorkContext>();
  for (const employee of employees) {
    const settings = settingsByEntity.get(employee.legalEntityId) as CompanySettings;

    const scheduleRow =
      employee.workSchedule ?? (settings.defaultWorkScheduleId ? scheduleById.get(settings.defaultWorkScheduleId) : undefined);

    const schedule: ResolvedSchedule = scheduleRow
      ? {
          id: scheduleRow.id,
          name: scheduleRow.name,
          timezone: scheduleRow.timezone,
          days: normaliseScheduleDays(scheduleRow.days),
          isFallback: false,
        }
      : fallbackSchedule(employee.legalEntity.workWeek, Number(employee.legalEntity.weeklyHours));

    const employeeTimezone = employee.timezone ?? employee.workLocation?.timezone ?? employee.legalEntity.timezone;

    contexts.set(employee.id, {
      employeeId: employee.id,
      legalEntityId: employee.legalEntityId,
      employeeNumber: employee.employeeNumber,
      fullName: `${employee.firstName} ${employee.lastName}`,
      departmentId: employee.departmentId,
      managerId: employee.managerId,
      hireDateKey: toDateKey(employee.hireDate),
      exitDateKey: employee.exitDate ? toDateKey(employee.exitDate) : null,
      employeeTimezone,
      timezone: schedule.timezone ?? employeeTimezone,
      schedule,
      workWeek: schedule.days.filter((day) => day.isWorkingDay).map((day) => day.dayOfWeek),
      holidayCalendarId:
        employee.holidayCalendarId ??
        settings.defaultHolidayCalendarId ??
        firstCalendarByEntity.get(employee.legalEntityId) ??
        null,
      overtimeEligible: employee.overtimeEligible,
      settings,
    });
  }

  return contexts;
}

export async function loadWorkContext(employeeId: string, client: TxClient = prisma): Promise<EmployeeWorkContext> {
  const context = (await loadWorkContexts([employeeId], client)).get(employeeId);
  if (!context) throw new NotFoundError('Employee');
  return context;
}

export interface HolidayEntry {
  name: string;
  type: HolidayType;
}

/**
 * Holidays per calendar within an inclusive date range, keyed by date.
 *
 * Holidays flagged `isRecurringAnnually` are expanded into every year the range
 * touches, so a fixed-date holiday entered once (2 December) applies every year.
 * An explicitly dated holiday wins over a recurring one on the same day.
 */
export async function loadHolidayDates(
  calendarIds: (string | null)[],
  fromKey: string,
  toKey: string,
  client: TxClient = prisma,
): Promise<Map<string, Map<string, HolidayEntry>>> {
  const ids = [...new Set(calendarIds.filter((id): id is string => Boolean(id)))];
  const result = new Map<string, Map<string, HolidayEntry>>(ids.map((id) => [id, new Map()]));
  if (ids.length === 0) return result;

  const from = new Date(`${fromKey}T00:00:00.000Z`);
  const to = new Date(`${toKey}T00:00:00.000Z`);

  const rows = await client.holiday.findMany({
    where: {
      calendarId: { in: ids },
      OR: [{ date: { gte: from, lte: to } }, { isRecurringAnnually: true }],
    },
    select: { calendarId: true, name: true, date: true, type: true, isRecurringAnnually: true },
    orderBy: { date: 'asc' },
  });

  const recurring = rows.filter((row) => row.isRecurringAnnually);
  const explicit = rows.filter((row) => row.date >= from && row.date <= to);

  for (const row of recurring) {
    const month = row.date.getUTCMonth();
    const day = row.date.getUTCDate();
    for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
      const occurrence = new Date(Date.UTC(year, month, day));
      // 29 February does not exist in a non-leap year; skip rather than roll over.
      if (occurrence.getUTCMonth() !== month) continue;
      if (occurrence < from || occurrence > to) continue;
      result.get(row.calendarId)?.set(toDateKey(occurrence), { name: row.name, type: row.type });
    }
  }
  for (const row of explicit) {
    result.get(row.calendarId)?.set(toDateKey(row.date), { name: row.name, type: row.type });
  }

  return result;
}
