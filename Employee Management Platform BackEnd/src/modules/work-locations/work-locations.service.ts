import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, NotFoundError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertCanManageEntityConfig, entityScopeWhere, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { resolveLegalEntityId } from '../../services/company';
import { timeZoneSchema } from '../settings/settings.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const workLocationSchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  code: requiredTrimmedString(2, 30).transform((value) => value.toUpperCase().replace(/\s+/g, '-')),
  name: requiredTrimmedString(2, 120),
  kind: z.enum(['OFFICE', 'REMOTE', 'FIELD', 'OTHER']).default('OFFICE'),
  addressLine: optionalTrimmedString(200),
  city: optionalTrimmedString(80),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  countryName: optionalTrimmedString(80),
  timezone: timeZoneSchema.optional(),
  isActive: z.boolean().default(true),
});

export const updateWorkLocationSchema = workLocationSchema
  .omit({ legalEntityId: true, code: true })
  .partial()
  .extend({ timezone: timeZoneSchema.nullable().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export type WorkLocationInput = z.infer<typeof workLocationSchema>;
export type UpdateWorkLocationInput = z.infer<typeof updateWorkLocationSchema>;

type LocationRow = Prisma.WorkLocationGetPayload<object>;

function serialize(location: LocationRow, headcount?: number) {
  return {
    id: location.id,
    legalEntityId: location.legalEntityId,
    code: location.code,
    name: location.name,
    kind: location.kind,
    addressLine: location.addressLine,
    city: location.city,
    countryCode: location.countryCode,
    countryName: location.countryName,
    timezone: location.timezone,
    isActive: location.isActive,
    ...(headcount === undefined ? {} : { headcount }),
  };
}

/**
 * Locations are reference data every screen needs (filters, profile, forms),
 * so any authenticated user can read them. Headcounts are counted within the
 * caller's scope.
 */
export async function listWorkLocations(auth: AuthContext, options: { includeInactive?: boolean } = {}): Promise<unknown[]> {
  const scope = scopedEntityId(auth);
  const locations = await prisma.workLocation.findMany({
    where: {
      ...(scope ? { legalEntityId: scope } : {}),
      ...(options.includeInactive && isManagement(auth) ? {} : { isActive: true }),
    },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });

  const counts = await prisma.employee.groupBy({
    by: ['workLocationId'],
    where: { status: { not: 'OFFBOARDED' }, ...entityScopeWhere(auth) },
    _count: { _all: true },
  });
  const countByLocation = new Map(counts.map((row) => [row.workLocationId, row._count._all]));

  return locations.map((location) => serialize(location, countByLocation.get(location.id) ?? 0));
}

/**
 * Where the team actually is: active headcount by work mode, country, city and
 * timezone. Remote people are what makes this useful - "3 in Cairo, 1 in
 * Algiers" - so it is grouped on the employee's own work country and city.
 */
export async function getWorkforceDistribution(auth: AuthContext): Promise<unknown> {
  const employees = await prisma.employee.findMany({
    where: { status: { not: 'OFFBOARDED' }, ...entityScopeWhere(auth) },
    select: {
      workMode: true,
      workCountry: true,
      workCity: true,
      timezone: true,
      workLocation: { select: { name: true, city: true, countryName: true, timezone: true } },
      legalEntity: { select: { city: true, countryName: true, timezone: true } },
    },
  });

  const byMode: Record<string, number> = { ONSITE: 0, HYBRID: 0, REMOTE: 0, FIELD: 0 };
  const places = new Map<string, { country: string; city: string; timezone: string; headcount: number; remote: number }>();

  for (const employee of employees) {
    byMode[employee.workMode] = (byMode[employee.workMode] ?? 0) + 1;
    const country = employee.workCountry ?? employee.workLocation?.countryName ?? employee.legalEntity.countryName;
    const city = employee.workCity ?? employee.workLocation?.city ?? employee.legalEntity.city;
    const timezone = employee.timezone ?? employee.workLocation?.timezone ?? employee.legalEntity.timezone;
    const key = `${country}|${city}|${timezone}`;
    const bucket = places.get(key) ?? { country, city, timezone, headcount: 0, remote: 0 };
    bucket.headcount += 1;
    if (employee.workMode === 'REMOTE') bucket.remote += 1;
    places.set(key, bucket);
  }

  return {
    total: employees.length,
    byWorkMode: byMode,
    places: [...places.values()].sort((a, b) => b.headcount - a.headcount),
  };
}

export async function createWorkLocation(
  auth: AuthContext,
  input: WorkLocationInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertCanManageEntityConfig(auth, legalEntityId);

  const existing = await prisma.workLocation.findUnique({ where: { code: input.code }, select: { id: true } });
  if (existing) throw new ConflictError(`A work location with code ${input.code} already exists`);

  const location = await prisma.workLocation.create({
    data: {
      legalEntityId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      countryCode: input.countryCode ?? null,
      countryName: input.countryName ?? null,
      timezone: input.timezone ?? null,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'WorkLocation',
    entityId: location.id,
    legalEntityId,
    summary: `Created work location ${location.name} (${location.kind.toLowerCase()})`,
    actor: auth,
    ...fingerprint,
  });

  return serialize(location, 0);
}

export async function updateWorkLocation(
  auth: AuthContext,
  locationId: string,
  input: UpdateWorkLocationInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const existing = await prisma.workLocation.findUnique({ where: { id: locationId } });
  if (!existing) throw new NotFoundError('Work location');
  assertCanManageEntityConfig(auth, existing.legalEntityId);

  const location = await prisma.workLocation.update({
    where: { id: locationId },
    data: {
      name: input.name,
      kind: input.kind,
      addressLine: input.addressLine,
      city: input.city,
      countryCode: input.countryCode,
      countryName: input.countryName,
      timezone: input.timezone,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'WorkLocation',
    entityId: locationId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated work location ${location.name}`,
    before: { name: existing.name, kind: existing.kind, timezone: existing.timezone, isActive: existing.isActive },
    after: { name: location.name, kind: location.kind, timezone: location.timezone, isActive: location.isActive },
    actor: auth,
    ...fingerprint,
  });

  return serialize(location);
}
