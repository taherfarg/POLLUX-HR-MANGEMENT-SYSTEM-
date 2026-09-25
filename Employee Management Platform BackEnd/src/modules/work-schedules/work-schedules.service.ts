import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanManageEntityConfig,
  assertEntityInScope,
  entityScopeWhere,
  isManagement,
  scopedEntityId,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { getCompanySettings, resolveLegalEntityId } from '../../services/company';
import { clockToMinutes, minutesToClock } from '../../services/timezone';
import { normaliseScheduleDays, scheduledMinutesFor } from '../../services/work-context';
import { timeZoneSchema } from '../settings/settings.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const clockSchema = z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:00');

const dayInputSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    isWorkingDay: z.boolean(),
    startTime: clockSchema.optional(),
    endTime: clockSchema.optional(),
    breakMinutes: z.coerce.number().int().min(0).max(480).default(0),
  })
  .superRefine((day, ctx) => {
    if (!day.isWorkingDay) return;
    if (!day.startTime || !day.endTime) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A working day needs a start and end time', path: ['startTime'] });
      return;
    }
    const start = clockToMinutes(day.startTime);
    const end = clockToMinutes(day.endTime);
    // Overnight shifts are out of scope: a shift must start and end on the same
    // calendar day, which keeps "which day does this check-in belong to" exact.
    if (end <= start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The end time must be after the start time', path: ['endTime'] });
      return;
    }
    if (day.breakMinutes >= end - start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The break must be shorter than the shift', path: ['breakMinutes'] });
    }
  });

const daysSchema = z
  .array(dayInputSchema)
  .min(1)
  .max(7)
  .refine((days) => new Set(days.map((day) => day.dayOfWeek)).size === days.length, 'Each weekday can appear only once')
  .refine((days) => days.some((day) => day.isWorkingDay), 'A schedule needs at least one working day');

export const workScheduleSchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  code: requiredTrimmedString(2, 30).transform((value) => value.toUpperCase().replace(/\s+/g, '-')),
  name: requiredTrimmedString(2, 120),
  description: optionalTrimmedString(300),
  /** Omit for a schedule read in each employee's own timezone. */
  timezone: timeZoneSchema.optional(),
  isActive: z.boolean().default(true),
  days: daysSchema,
});

export const updateWorkScheduleSchema = z
  .object({
    name: requiredTrimmedString(2, 120),
    description: optionalTrimmedString(300),
    timezone: timeZoneSchema.nullable(),
    isActive: z.boolean(),
    days: daysSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const assignScheduleSchema = z.object({
  employeeIds: z.array(z.string().trim().min(1).max(40)).min(1).max(500),
});

export type WorkScheduleInput = z.infer<typeof workScheduleSchema>;
export type UpdateWorkScheduleInput = z.infer<typeof updateWorkScheduleSchema>;

const scheduleInclude = { days: { orderBy: { dayOfWeek: 'asc' } } } satisfies Prisma.WorkScheduleInclude;
type ScheduleRow = Prisma.WorkScheduleGetPayload<{ include: typeof scheduleInclude }>;

function serialize(schedule: ScheduleRow, extra: { employeeCount?: number; isCompanyDefault?: boolean } = {}) {
  const days = normaliseScheduleDays(schedule.days).map((day) => ({
    dayOfWeek: day.dayOfWeek,
    dayName: WEEKDAY_NAMES[day.dayOfWeek],
    isWorkingDay: day.isWorkingDay,
    startTime: minutesToClock(day.startMinute),
    endTime: minutesToClock(day.endMinute),
    breakMinutes: day.breakMinutes,
    scheduledMinutes: scheduledMinutesFor(day),
  }));
  return {
    id: schedule.id,
    legalEntityId: schedule.legalEntityId,
    code: schedule.code,
    name: schedule.name,
    description: schedule.description,
    timezone: schedule.timezone,
    timezoneMode: schedule.timezone ? 'FIXED' : 'EMPLOYEE_LOCAL',
    isActive: schedule.isActive,
    days,
    weeklyMinutes: days.reduce((total, day) => total + day.scheduledMinutes, 0),
    workingDays: days.filter((day) => day.isWorkingDay).map((day) => day.dayOfWeek),
    ...(extra.employeeCount === undefined ? {} : { employeeCount: extra.employeeCount }),
    ...(extra.isCompanyDefault === undefined ? {} : { isCompanyDefault: extra.isCompanyDefault }),
  };
}

function toDayRows(days: z.infer<typeof daysSchema>) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const day = days.find((candidate) => candidate.dayOfWeek === dayOfWeek);
    if (!day || !day.isWorkingDay || !day.startTime || !day.endTime) {
      return { dayOfWeek, isWorkingDay: false, startMinute: null, endMinute: null, breakMinutes: 0 };
    }
    return {
      dayOfWeek,
      isWorkingDay: true,
      startMinute: clockToMinutes(day.startTime),
      endMinute: clockToMinutes(day.endTime),
      breakMinutes: day.breakMinutes,
    };
  });
}

/** Schedules are reference data: anyone signed in may read them. */
export async function listWorkSchedules(auth: AuthContext, options: { includeInactive?: boolean } = {}): Promise<unknown[]> {
  const scope = scopedEntityId(auth);
  const schedules = await prisma.workSchedule.findMany({
    where: {
      ...(scope ? { legalEntityId: scope } : {}),
      ...(options.includeInactive && isManagement(auth) ? {} : { isActive: true }),
    },
    include: scheduleInclude,
    orderBy: { name: 'asc' },
  });

  const counts = await prisma.employee.groupBy({
    by: ['workScheduleId'],
    where: { status: { not: 'OFFBOARDED' }, ...entityScopeWhere(auth) },
    _count: { _all: true },
  });
  const countBySchedule = new Map(counts.map((row) => [row.workScheduleId, row._count._all]));

  const defaults = new Set(
    (await prisma.companySettings.findMany({ select: { defaultWorkScheduleId: true } }))
      .map((row) => row.defaultWorkScheduleId)
      .filter(Boolean),
  );

  return schedules.map((schedule) =>
    serialize(schedule, { employeeCount: countBySchedule.get(schedule.id) ?? 0, isCompanyDefault: defaults.has(schedule.id) }),
  );
}

export async function getWorkSchedule(auth: AuthContext, scheduleId: string): Promise<unknown> {
  const schedule = await prisma.workSchedule.findUnique({ where: { id: scheduleId }, include: scheduleInclude });
  if (!schedule) throw new NotFoundError('Work schedule');
  if (isManagement(auth)) assertEntityInScope(auth, schedule.legalEntityId);
  const settings = await getCompanySettings(schedule.legalEntityId);
  return serialize(schedule, { isCompanyDefault: settings.defaultWorkScheduleId === schedule.id });
}

export async function createWorkSchedule(
  auth: AuthContext,
  input: WorkScheduleInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertCanManageEntityConfig(auth, legalEntityId);

  const existing = await prisma.workSchedule.findUnique({ where: { code: input.code }, select: { id: true } });
  if (existing) throw new ConflictError(`A schedule with code ${input.code} already exists`);

  const schedule = await prisma.workSchedule.create({
    data: {
      legalEntityId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      timezone: input.timezone ?? null,
      isActive: input.isActive,
      days: { create: toDayRows(input.days) },
    },
    include: scheduleInclude,
  });

  const serialized = serialize(schedule, { employeeCount: 0 });
  await recordAudit({
    action: 'CREATE',
    entityType: 'WorkSchedule',
    entityId: schedule.id,
    legalEntityId,
    summary: `Created work schedule ${schedule.name}`,
    after: { days: serialized.days.map((day) => `${day.dayName}: ${day.isWorkingDay ? `${day.startTime}-${day.endTime}` : 'off'}`) },
    actor: auth,
    ...fingerprint,
  });

  return serialized;
}

export async function updateWorkSchedule(
  auth: AuthContext,
  scheduleId: string,
  input: UpdateWorkScheduleInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const existing = await prisma.workSchedule.findUnique({ where: { id: scheduleId }, include: scheduleInclude });
  if (!existing) throw new NotFoundError('Work schedule');
  assertCanManageEntityConfig(auth, existing.legalEntityId);

  if (input.isActive === false) {
    const settings = await getCompanySettings(existing.legalEntityId);
    if (settings.defaultWorkScheduleId === scheduleId) {
      throw new ValidationError('Validation failed', {
        isActive: ['This is the company default schedule. Choose another default before deactivating it.'],
      });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (input.days) {
      // Replacing the seven rows is simpler and safer than diffing them.
      await tx.workScheduleDay.deleteMany({ where: { scheduleId } });
      await tx.workScheduleDay.createMany({ data: toDayRows(input.days).map((day) => ({ ...day, scheduleId })) });
    }
    return tx.workSchedule.update({
      where: { id: scheduleId },
      data: {
        name: input.name,
        description: input.description,
        timezone: input.timezone,
        isActive: input.isActive,
      },
      include: scheduleInclude,
    });
  });

  const before = serialize(existing);
  const after = serialize(updated);
  await recordAudit({
    action: 'UPDATE',
    entityType: 'WorkSchedule',
    entityId: scheduleId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated work schedule ${updated.name}`,
    before: { timezone: before.timezone, isActive: before.isActive, days: before.days.map((d) => `${d.dayName}: ${d.isWorkingDay ? `${d.startTime}-${d.endTime}/${d.breakMinutes}m` : 'off'}`) },
    after: { timezone: after.timezone, isActive: after.isActive, days: after.days.map((d) => `${d.dayName}: ${d.isWorkingDay ? `${d.startTime}-${d.endTime}/${d.breakMinutes}m` : 'off'}`) },
    actor: auth,
    ...fingerprint,
  });

  return after;
}

/**
 * Assigns one schedule to several employees at once - the common HR action
 * ("everyone in the office moves to summer hours"). Every employee must be in
 * the caller's scope and in the schedule's company.
 */
export async function assignWorkSchedule(
  auth: AuthContext,
  scheduleId: string,
  employeeIds: string[],
  fingerprint: Fingerprint,
): Promise<{ assigned: number }> {
  const schedule = await prisma.workSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new NotFoundError('Work schedule');
  assertCanManageEntityConfig(auth, schedule.legalEntityId);
  if (!schedule.isActive) {
    throw new ValidationError('Validation failed', { scheduleId: ['This schedule is inactive'] });
  }

  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, legalEntityId: true, employeeNumber: true },
  });
  if (employees.length !== new Set(employeeIds).size) {
    throw new ValidationError('Validation failed', { employeeIds: ['One or more employees do not exist'] });
  }
  for (const employee of employees) {
    assertEntityInScope(auth, employee.legalEntityId);
    if (employee.legalEntityId !== schedule.legalEntityId) {
      throw new ValidationError('Validation failed', {
        employeeIds: [`${employee.employeeNumber} belongs to another company than this schedule`],
      });
    }
  }

  const result = await prisma.employee.updateMany({
    where: { id: { in: employees.map((employee) => employee.id) } },
    data: { workScheduleId: scheduleId },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'WorkSchedule',
    entityId: scheduleId,
    legalEntityId: schedule.legalEntityId,
    summary: `Assigned ${schedule.name} to ${result.count} employee(s)`,
    after: { employees: employees.map((employee) => employee.employeeNumber) },
    actor: auth,
    ...fingerprint,
  });

  return { assigned: result.count };
}
