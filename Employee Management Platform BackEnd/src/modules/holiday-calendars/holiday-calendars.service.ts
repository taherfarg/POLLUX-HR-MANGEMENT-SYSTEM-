import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertCanManageEntityConfig, entityScopeWhere, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { getCompanySettings, resolveLegalEntityId } from '../../services/company';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const holidayCalendarSchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  code: requiredTrimmedString(2, 40).transform((value) => value.toUpperCase().replace(/\s+/g, '-')),
  name: requiredTrimmedString(2, 120),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  description: optionalTrimmedString(300),
  isActive: z.boolean().default(true),
});

export const updateHolidayCalendarSchema = holidayCalendarSchema
  .omit({ legalEntityId: true, code: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export type HolidayCalendarInput = z.infer<typeof holidayCalendarSchema>;
export type UpdateHolidayCalendarInput = z.infer<typeof updateHolidayCalendarSchema>;

/**
 * Calendars are reference data (the holiday page, the employee form), so any
 * signed-in user can read the list. Counts are within the caller's scope.
 */
export async function listHolidayCalendars(auth: AuthContext): Promise<unknown[]> {
  const scope = scopedEntityId(auth);
  const calendars = await prisma.holidayCalendar.findMany({
    where: {
      ...(scope ? { legalEntityId: scope } : {}),
      ...(isManagement(auth) ? {} : { isActive: true }),
    },
    include: { _count: { select: { holidays: true } } },
    orderBy: { name: 'asc' },
  });

  const [assigned, settings] = await Promise.all([
    prisma.employee.groupBy({
      by: ['holidayCalendarId'],
      where: { status: { not: 'OFFBOARDED' }, ...entityScopeWhere(auth) },
      _count: { _all: true },
    }),
    prisma.companySettings.findMany({ select: { defaultHolidayCalendarId: true } }),
  ]);
  const assignedByCalendar = new Map(assigned.map((row) => [row.holidayCalendarId, row._count._all]));
  const defaults = new Set(settings.map((row) => row.defaultHolidayCalendarId).filter(Boolean));

  return calendars.map((calendar) => ({
    id: calendar.id,
    legalEntityId: calendar.legalEntityId,
    code: calendar.code,
    name: calendar.name,
    countryCode: calendar.countryCode,
    description: calendar.description,
    isActive: calendar.isActive,
    isCompanyDefault: defaults.has(calendar.id),
    holidayCount: calendar._count.holidays,
    /** Employees explicitly assigned; everyone else follows the default. */
    assignedEmployees: assignedByCalendar.get(calendar.id) ?? 0,
  }));
}

export async function createHolidayCalendar(
  auth: AuthContext,
  input: HolidayCalendarInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertCanManageEntityConfig(auth, legalEntityId);

  const existing = await prisma.holidayCalendar.findUnique({ where: { code: input.code }, select: { id: true } });
  if (existing) throw new ConflictError(`A holiday calendar with code ${input.code} already exists`);

  const calendar = await prisma.holidayCalendar.create({
    data: {
      legalEntityId,
      code: input.code,
      name: input.name,
      countryCode: input.countryCode ?? null,
      description: input.description ?? null,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'HolidayCalendar',
    entityId: calendar.id,
    legalEntityId,
    summary: `Created holiday calendar ${calendar.name}`,
    actor: auth,
    ...fingerprint,
  });

  return { ...calendar, isCompanyDefault: false, holidayCount: 0, assignedEmployees: 0 };
}

export async function updateHolidayCalendar(
  auth: AuthContext,
  calendarId: string,
  input: UpdateHolidayCalendarInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const existing = await prisma.holidayCalendar.findUnique({ where: { id: calendarId } });
  if (!existing) throw new NotFoundError('Holiday calendar');
  assertCanManageEntityConfig(auth, existing.legalEntityId);

  if (input.isActive === false) {
    const settings = await getCompanySettings(existing.legalEntityId);
    if (settings.defaultHolidayCalendarId === calendarId) {
      throw new ValidationError('Validation failed', {
        isActive: ['This is the company default calendar. Choose another default before deactivating it.'],
      });
    }
  }

  const calendar = await prisma.holidayCalendar.update({
    where: { id: calendarId },
    data: {
      name: input.name,
      countryCode: input.countryCode,
      description: input.description,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'HolidayCalendar',
    entityId: calendarId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated holiday calendar ${calendar.name}`,
    before: { name: existing.name, isActive: existing.isActive },
    after: { name: calendar.name, isActive: calendar.isActive },
    actor: auth,
    ...fingerprint,
  });

  return calendar;
}
