import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertEntityInScope, assertIsManagement, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { countWorkingDays } from '../../services/working-days';
import { getCompanySettings, resolveLegalEntityId } from '../../services/company';
import { loadHolidayDates, loadWorkContext, type HolidayEntry } from '../../services/work-context';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const leaveTypeSchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  code: requiredTrimmedString(2, 30).transform((value) => value.toUpperCase()),
  name: requiredTrimmedString(2, 80),
  description: optionalTrimmedString(300),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour such as #2563eb')
    .default('#64748b'),
  annualEntitlementDays: z.coerce.number().min(0).max(365),
  isPaid: z.boolean().default(true),
  requiresAttachment: z.boolean().default(false),
  allowsHalfDay: z.boolean().default(true),
  minNoticeDays: z.coerce.number().int().min(0).max(180).default(0),
  maxConsecutiveDays: z.coerce.number().int().min(1).max(365).optional(),
  carryOverMaxDays: z.coerce.number().min(0).max(90).default(0),
  restrictedToGender: z.enum(['MALE', 'FEMALE', 'UNDISCLOSED']).optional(),
  isActive: z.boolean().default(true),
});

/**
 * `legalEntityId` and `calendarId` are both optional: with neither, the holiday
 * goes into the primary company's default calendar - the common case for a
 * single-company deployment. The original entity-only payload still works.
 */
export const holidaySchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  calendarId: optionalTrimmedString(40),
  name: requiredTrimmedString(2, 120),
  date: dateStringSchema,
  type: z.enum(['PUBLIC', 'COMPANY']).default('PUBLIC'),
  isRecurringAnnually: z.boolean().default(false),
});

export const updateHolidaySchema = z
  .object({
    name: requiredTrimmedString(2, 120),
    date: dateStringSchema,
    type: z.enum(['PUBLIC', 'COMPANY']),
    isRecurringAnnually: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const calendarQuerySchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  legalEntityId: optionalTrimmedString(40),
});

export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;
export type HolidayInput = z.infer<typeof holidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;

function serializeLeaveType(type: {
  id: string;
  legalEntityId: string | null;
  code: string;
  name: string;
  description: string | null;
  colorHex: string;
  annualEntitlementDays: Prisma.Decimal;
  isPaid: boolean;
  requiresAttachment: boolean;
  allowsHalfDay: boolean;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
  carryOverMaxDays: Prisma.Decimal;
  restrictedToGender: string | null;
  isActive: boolean;
}) {
  return {
    id: type.id,
    legalEntityId: type.legalEntityId,
    code: type.code,
    name: type.name,
    description: type.description,
    colorHex: type.colorHex,
    annualEntitlementDays: Number(type.annualEntitlementDays),
    isPaid: type.isPaid,
    requiresAttachment: type.requiresAttachment,
    allowsHalfDay: type.allowsHalfDay,
    minNoticeDays: type.minNoticeDays,
    maxConsecutiveDays: type.maxConsecutiveDays,
    carryOverMaxDays: Number(type.carryOverMaxDays),
    restrictedToGender: type.restrictedToGender,
    isActive: type.isActive,
    /** Null entity means the policy is company-wide. */
    scope: type.legalEntityId ? 'ENTITY' : 'GLOBAL',
  };
}

/**
 * Leave policy applicable to one legal entity: its own types plus any
 * company-wide ones. This is how the same platform serves a UAE entity with 30
 * days of annual leave and an Egyptian entity with 21.
 */
export async function listLeaveTypes(
  auth: AuthContext,
  filters: { legalEntityId?: string; includeInactive?: boolean },
): Promise<unknown[]> {
  /**
   * Who gets to see which entity's policy:
   *
   *  - An employee or manager only ever sees their own entity's types plus the
   *    company-wide ones. Without this they were offered every entity's leave
   *    types at once - four near-identical "Annual Leave" options in the request
   *    form, three of which the submit endpoint then rejects as belonging to
   *    another legal entity.
   *  - A scoped HR_ADMIN is pinned to their scope; a filter cannot widen it.
   *  - A global ADMIN may filter freely, or see everything.
   */
  const scope = scopedEntityId(auth);
  const entityId = isManagement(auth)
    ? (scope ?? filters.legalEntityId ?? undefined)
    : (auth.legalEntityId ?? undefined);

  const types = await prisma.leaveType.findMany({
    where: {
      ...(filters.includeInactive && isManagement(auth) ? {} : { isActive: true }),
      ...(entityId ? { OR: [{ legalEntityId: entityId }, { legalEntityId: null }] } : {}),
    },
    orderBy: [{ legalEntityId: 'asc' }, { name: 'asc' }],
  });

  return types.map(serializeLeaveType);
}

export async function createLeaveType(
  auth: AuthContext,
  input: LeaveTypeInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  assertIsManagement(auth);
  if (input.legalEntityId) assertEntityInScope(auth, input.legalEntityId);

  const created = await prisma.leaveType.create({
    data: {
      legalEntityId: input.legalEntityId ?? null,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      colorHex: input.colorHex,
      annualEntitlementDays: new Prisma.Decimal(input.annualEntitlementDays),
      isPaid: input.isPaid,
      requiresAttachment: input.requiresAttachment,
      allowsHalfDay: input.allowsHalfDay,
      minNoticeDays: input.minNoticeDays,
      maxConsecutiveDays: input.maxConsecutiveDays ?? null,
      carryOverMaxDays: new Prisma.Decimal(input.carryOverMaxDays),
      restrictedToGender: input.restrictedToGender ?? null,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'LeaveType',
    entityId: created.id,
    legalEntityId: created.legalEntityId,
    summary: `Created leave type ${created.code} (${created.name})`,
    actor: auth,
    ...fingerprint,
  });

  return serializeLeaveType(created);
}

export async function updateLeaveType(
  auth: AuthContext,
  leaveTypeId: string,
  input: Partial<LeaveTypeInput>,
  fingerprint: Fingerprint,
): Promise<unknown> {
  assertIsManagement(auth);

  const existing = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
  if (!existing) {
    throw new NotFoundError('Leave type');
  }
  if (existing.legalEntityId) assertEntityInScope(auth, existing.legalEntityId);

  const updated = await prisma.leaveType.update({
    where: { id: leaveTypeId },
    data: {
      name: input.name,
      description: input.description,
      colorHex: input.colorHex,
      annualEntitlementDays:
        input.annualEntitlementDays === undefined ? undefined : new Prisma.Decimal(input.annualEntitlementDays),
      isPaid: input.isPaid,
      requiresAttachment: input.requiresAttachment,
      allowsHalfDay: input.allowsHalfDay,
      minNoticeDays: input.minNoticeDays,
      maxConsecutiveDays: input.maxConsecutiveDays,
      carryOverMaxDays: input.carryOverMaxDays === undefined ? undefined : new Prisma.Decimal(input.carryOverMaxDays),
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'LeaveType',
    entityId: leaveTypeId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated leave type ${updated.code}`,
    actor: auth,
    ...fingerprint,
  });

  return serializeLeaveType(updated);
}

const holidayInclude = {
  legalEntity: { select: { id: true, code: true, name: true, countryCode: true } },
  calendar: { select: { id: true, code: true, name: true } },
} satisfies Prisma.HolidayInclude;

function serializeHoliday(holiday: Prisma.HolidayGetPayload<{ include: typeof holidayInclude }>) {
  return {
    id: holiday.id,
    name: holiday.name,
    date: holiday.date.toISOString().slice(0, 10),
    type: holiday.type,
    isRecurringAnnually: holiday.isRecurringAnnually,
    legalEntity: holiday.legalEntity,
    calendar: holiday.calendar,
  };
}

export async function listHolidays(
  auth: AuthContext,
  filters: { legalEntityId?: string; calendarId?: string; year?: number },
): Promise<unknown[]> {
  const entityId = filters.legalEntityId ?? scopedEntityId(auth) ?? undefined;
  const year = filters.year;

  const holidays = await prisma.holiday.findMany({
    where: {
      ...(entityId ? { legalEntityId: entityId } : {}),
      ...(filters.calendarId ? { calendarId: filters.calendarId } : {}),
      ...(year
        ? { date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }
        : {}),
    },
    include: holidayInclude,
    orderBy: { date: 'asc' },
  });

  return holidays.map(serializeHoliday);
}

/**
 * The calendar a new holiday belongs to: the one named, else the entity's
 * default calendar, else its first calendar - and if the entity has none yet,
 * one is created so the holiday always has a home.
 */
async function resolveHolidayCalendar(
  auth: AuthContext,
  input: { legalEntityId?: string; calendarId?: string },
): Promise<{ id: string; legalEntityId: string }> {
  if (input.calendarId) {
    const calendar = await prisma.holidayCalendar.findUnique({
      where: { id: input.calendarId },
      select: { id: true, legalEntityId: true },
    });
    if (!calendar) {
      throw new ValidationError('Validation failed', { calendarId: ['Holiday calendar does not exist'] });
    }
    assertEntityInScope(auth, calendar.legalEntityId);
    if (input.legalEntityId && input.legalEntityId !== calendar.legalEntityId) {
      throw new ValidationError('Validation failed', { calendarId: ['This calendar belongs to another company'] });
    }
    return calendar;
  }

  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertEntityInScope(auth, legalEntityId);

  const settings = await getCompanySettings(legalEntityId);
  if (settings.defaultHolidayCalendarId) {
    return { id: settings.defaultHolidayCalendarId, legalEntityId };
  }

  const first = await prisma.holidayCalendar.findFirst({
    where: { legalEntityId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, legalEntityId: true },
  });
  if (first) return first;

  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { id: legalEntityId },
    select: { code: true, name: true, countryCode: true },
  });
  return prisma.holidayCalendar.create({
    data: {
      legalEntityId,
      code: `${entity.code}-HOLIDAYS`,
      name: `${entity.name} Public Holidays`,
      countryCode: entity.countryCode,
    },
    select: { id: true, legalEntityId: true },
  });
}

export async function createHoliday(
  auth: AuthContext,
  input: HolidayInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  assertIsManagement(auth);
  const calendar = await resolveHolidayCalendar(auth, input);

  const holiday = await prisma.holiday.create({
    data: {
      legalEntityId: calendar.legalEntityId,
      calendarId: calendar.id,
      name: input.name,
      date: toUtcDate(input.date),
      type: input.type,
      isRecurringAnnually: input.isRecurringAnnually,
    },
    include: holidayInclude,
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'Holiday',
    entityId: holiday.id,
    legalEntityId: holiday.legalEntityId,
    summary: `Added ${input.type === 'COMPANY' ? 'company' : 'public'} holiday ${input.name} on ${input.date} (${holiday.calendar.name})`,
    actor: auth,
    ...fingerprint,
  });

  return serializeHoliday(holiday);
}

export async function updateHoliday(
  auth: AuthContext,
  holidayId: string,
  input: UpdateHolidayInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  assertIsManagement(auth);
  const existing = await prisma.holiday.findUnique({ where: { id: holidayId } });
  if (!existing) {
    throw new NotFoundError('Holiday');
  }
  assertEntityInScope(auth, existing.legalEntityId);

  const updated = await prisma.holiday.update({
    where: { id: holidayId },
    data: {
      name: input.name,
      date: input.date ? toUtcDate(input.date) : undefined,
      type: input.type,
      isRecurringAnnually: input.isRecurringAnnually,
    },
    include: holidayInclude,
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'Holiday',
    entityId: holidayId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated holiday ${updated.name}`,
    before: { name: existing.name, date: existing.date.toISOString().slice(0, 10), type: existing.type },
    after: { name: updated.name, date: updated.date.toISOString().slice(0, 10), type: updated.type },
    actor: auth,
    ...fingerprint,
  });

  return serializeHoliday(updated);
}

export async function deleteHoliday(
  auth: AuthContext,
  holidayId: string,
  fingerprint: Fingerprint,
): Promise<void> {
  assertIsManagement(auth);
  const holiday = await prisma.holiday.findUnique({ where: { id: holidayId } });
  if (!holiday) {
    throw new NotFoundError('Holiday');
  }
  assertEntityInScope(auth, holiday.legalEntityId);

  await prisma.holiday.delete({ where: { id: holidayId } });
  await recordAudit({
    action: 'DELETE',
    entityType: 'Holiday',
    entityId: holidayId,
    legalEntityId: holiday.legalEntityId,
    summary: `Removed public holiday ${holiday.name}`,
    actor: auth,
    ...fingerprint,
  });
}

/**
 * Converts a date range into chargeable leave days. Shared by the request
 * validator and by the "preview before you submit" endpoint so the number the
 * employee sees is the number that gets deducted.
 *
 * With an `employeeId` the calculation is employee-aware: the employee's own
 * work schedule decides which weekdays are working days (a part-timer on
 * Mon/Wed/Fri is only charged for those), and their holiday calendar decides
 * which days are holidays (a remote employee assigned the Egypt calendar skips
 * Egyptian holidays). With nothing assigned, both fall back to the legal
 * entity's work week and default calendar - exactly the original behaviour.
 */
export async function calculateLeaveDays(params: {
  legalEntityId: string;
  employeeId?: string;
  startDate: Date;
  endDate: Date;
  halfDayStart?: boolean;
  halfDayEnd?: boolean;
}): Promise<{ workingDays: number; holidays: { date: string; name: string }[] }> {
  let workWeek: number[];
  let calendarId: string | null;

  if (params.employeeId) {
    const context = await loadWorkContext(params.employeeId);
    workWeek = context.workWeek;
    calendarId = context.holidayCalendarId;
  } else {
    const entity = await prisma.legalEntity.findUnique({
      where: { id: params.legalEntityId },
      select: { workWeek: true },
    });
    if (!entity) {
      throw new NotFoundError('Legal entity');
    }
    workWeek = entity.workWeek;
    const settings = await getCompanySettings(params.legalEntityId);
    calendarId =
      settings.defaultHolidayCalendarId ??
      (
        await prisma.holidayCalendar.findFirst({
          where: { legalEntityId: params.legalEntityId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id ??
      null;
  }

  const fromKey = params.startDate.toISOString().slice(0, 10);
  const toKey = params.endDate.toISOString().slice(0, 10);
  const holidayMap = calendarId
    ? ((await loadHolidayDates([calendarId], fromKey, toKey)).get(calendarId) ?? new Map())
    : new Map<string, HolidayEntry>();
  const holidays = [...holidayMap.entries()]
    .map(([date, entry]) => ({ date, name: entry.name }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const workingDays = countWorkingDays({
    start: params.startDate,
    end: params.endDate,
    workWeek,
    holidays: holidays.map((holiday) => new Date(`${holiday.date}T00:00:00.000Z`)),
    halfDayStart: params.halfDayStart,
    halfDayEnd: params.halfDayEnd,
  });

  return { workingDays, holidays };
}

export async function getLeaveBalances(employeeId: string, year: number): Promise<unknown[]> {
  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId, year },
    include: { leaveType: true },
    orderBy: { leaveType: { name: 'asc' } },
  });

  return balances.map((balance) => {
    const entitled = Number(balance.entitledDays) + Number(balance.carriedOverDays);
    const used = Number(balance.usedDays);
    const pending = Number(balance.pendingDays);
    return {
      id: balance.id,
      year: balance.year,
      leaveType: serializeLeaveType(balance.leaveType),
      entitledDays: Number(balance.entitledDays),
      carriedOverDays: Number(balance.carriedOverDays),
      usedDays: used,
      pendingDays: pending,
      // What the employee can still book today: entitlement minus what is taken
      // and what is already awaiting a decision.
      availableDays: Number((entitled - used - pending).toFixed(2)),
      totalEntitlement: Number(entitled.toFixed(2)),
    };
  });
}

/**
 * Team leave calendar. Everyone sees who is away and on what kind of leave,
 * which is the point of a shared calendar; the stated reason stays private to
 * the employee, their manager and HR.
 */
export async function getLeaveCalendar(
  auth: AuthContext,
  params: { from: Date; to: Date; legalEntityId?: string },
): Promise<unknown[]> {
  const entityId = params.legalEntityId ?? scopedEntityId(auth) ?? auth.legalEntityId ?? undefined;

  const entries = await prisma.leaveRequestDetail.findMany({
    where: {
      startDate: { lte: params.to },
      endDate: { gte: params.from },
      request: {
        status: 'APPROVED',
        ...(entityId ? { legalEntityId: entityId } : {}),
      },
    },
    include: {
      leaveType: { select: { id: true, name: true, colorHex: true, isPaid: true } },
      request: {
        select: {
          id: true,
          reference: true,
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              jobTitle: true,
              avatarUrl: true,
              managerId: true,
              legalEntityId: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { startDate: 'asc' },
  });

  return entries.map((entry) => {
    const employee = entry.request.employee;
    const maySeeReason =
      isManagement(auth) || employee.managerId === auth.employeeId || employee.id === auth.employeeId;

    return {
      requestId: entry.request.id,
      reference: entry.request.reference,
      startDate: entry.startDate.toISOString().slice(0, 10),
      endDate: entry.endDate.toISOString().slice(0, 10),
      workingDays: Number(entry.workingDays),
      halfDayStart: entry.halfDayStart,
      halfDayEnd: entry.halfDayEnd,
      leaveType: entry.leaveType,
      reason: maySeeReason ? entry.reason : null,
      employee: {
        id: employee.id,
        fullName: `${employee.firstName} ${employee.lastName}`,
        jobTitle: employee.jobTitle,
        avatarUrl: employee.avatarUrl,
        department: employee.department,
      },
    };
  });
}

/** Guards against a second request covering days already booked or pending. */
export async function assertNoOverlappingLeave(
  employeeId: string,
  startDate: Date,
  endDate: Date,
  excludeRequestId?: string,
): Promise<void> {
  const overlap = await prisma.leaveRequestDetail.findFirst({
    where: {
      startDate: { lte: endDate },
      endDate: { gte: startDate },
      request: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
      },
    },
    include: { request: { select: { reference: true, status: true } } },
  });

  if (overlap) {
    throw new ValidationError('Validation failed', {
      startDate: [
        `These dates overlap request ${overlap.request.reference}, which is ${overlap.request.status.toLowerCase()}`,
      ],
    });
  }
}
