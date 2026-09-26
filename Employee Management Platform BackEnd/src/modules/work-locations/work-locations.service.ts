import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { env } from '../../config/env';
import { assertCanManageEntityConfig, entityScopeWhere, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { resolveLegalEntityId } from '../../services/company';
import { isPrivateAddress, normalizeIp, parseNetworkEntry, suggestNetworkEntry } from '../../services/onsite';
import { timeZoneSchema } from '../settings/settings.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const networkEntrySchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => parseNetworkEntry(value) !== null, 'Use an IP address such as 203.0.113.7, or a range such as 203.0.113.0/24');

/** On-site check-in: the QR code, the geofence and the office network. */
const onsiteFields = {
  qrCheckInRequired: z.boolean(),
  // It travels inside a link, so only URL-safe characters.
  qrCode: z
    .string()
    .trim()
    .min(4, 'Use at least 4 characters')
    .max(100)
    .regex(/^[A-Za-z0-9._~-]+$/, 'Use letters, digits and - _ . ~ only')
    .nullable(),
  latitude: z.coerce.number().min(-90).max(90).nullable(),
  longitude: z.coerce.number().min(-180).max(180).nullable(),
  geofenceRadiusMeters: z.coerce.number().int().min(25, 'At least 25 m - phone positions are rarely closer').max(5000),
  allowedNetworks: z.array(networkEntrySchema).max(20),
  wifiName: z.string().trim().max(120).nullable(),
};

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
  ...z.object(onsiteFields).partial().shape,
});

export const updateWorkLocationSchema = workLocationSchema
  .omit({ legalEntityId: true, code: true })
  .partial()
  .extend({ timezone: timeZoneSchema.nullable().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export type WorkLocationInput = z.infer<typeof workLocationSchema>;
export type UpdateWorkLocationInput = z.infer<typeof updateWorkLocationSchema>;

type LocationRow = Prisma.WorkLocationGetPayload<object>;

/**
 * Everyone may know that a location checks in by QR code; only HR sees the
 * code, the office position and the office networks.
 */
function serialize(location: LocationRow, options: { headcount?: number; includeOnsite: boolean }) {
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
    qrCheckInRequired: location.qrCheckInRequired,
    ...(options.includeOnsite
      ? {
          qrCode: location.qrCode,
          latitude: location.latitude === null ? null : Number(location.latitude),
          longitude: location.longitude === null ? null : Number(location.longitude),
          geofenceRadiusMeters: location.geofenceRadiusMeters,
          allowedNetworks: location.allowedNetworks,
          wifiName: location.wifiName,
        }
      : {}),
    ...(options.headcount === undefined ? {} : { headcount: options.headcount }),
  };
}

interface OnsiteSettings {
  qrCheckInRequired: boolean;
  qrCode: string | null;
  latitude: number | null;
  longitude: number | null;
  allowedNetworks: string[];
}

/**
 * The on-site rule has to be usable once saved: a QR code to scan, and a
 * second signal besides - a printed code alone can be photographed and used
 * from anywhere. In production an office network must be a public address; a
 * private one would mean the server reads its proxy, and would let anyone in.
 */
function assertOnsiteUsable(settings: OnsiteSettings): void {
  const errors: Record<string, string[]> = {};
  if ((settings.latitude === null) !== (settings.longitude === null)) {
    errors.latitude = ['Enter both the latitude and the longitude, or neither'];
  }
  if (settings.qrCheckInRequired) {
    if (!settings.qrCode) errors.qrCode = ['Set the code the printed QR carries'];
    if (settings.latitude === null && settings.allowedNetworks.length === 0) {
      errors.qrCheckInRequired = [
        'Add the office position or its network as well - a QR code alone can be photographed and used from anywhere',
      ];
    }
  }
  if (env.isProduction) {
    const privateEntry = settings.allowedNetworks.find((entry) => isPrivateAddress(parseNetworkEntry(entry)?.address));
    if (privateEntry) {
      errors.allowedNetworks = [`${privateEntry} is a private address, not the office's public internet address`];
    }
  }
  if (Object.keys(errors).length > 0) throw new ValidationError('Validation failed', errors);
}

const uniqueNetworks = (entries: string[]) => [...new Set(entries.map((entry) => entry.trim()))];

/** What the audit trail records about the on-site rule - never the code itself. */
function onsiteAudit(location: LocationRow) {
  return {
    qrCheckInRequired: location.qrCheckInRequired,
    hasQrCode: Boolean(location.qrCode),
    latitude: location.latitude === null ? null : Number(location.latitude),
    longitude: location.longitude === null ? null : Number(location.longitude),
    geofenceRadiusMeters: location.geofenceRadiusMeters,
    allowedNetworks: location.allowedNetworks,
  };
}

/**
 * The address this request reaches the API from, and the entry to store for
 * it. Pressed while on the office Wi-Fi, this is the office's own network.
 */
export function describeCallerNetwork(ip: string | null | undefined): { ip: string | null; entry: string | null; isPrivate: boolean } {
  const address = normalizeIp(ip);
  return { ip: address, entry: suggestNetworkEntry(address), isPrivate: isPrivateAddress(address) };
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

  return locations.map((location) =>
    serialize(location, { headcount: countByLocation.get(location.id) ?? 0, includeOnsite: isManagement(auth) }),
  );
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

  const allowedNetworks = uniqueNetworks(input.allowedNetworks ?? []);
  assertOnsiteUsable({
    qrCheckInRequired: input.qrCheckInRequired ?? false,
    qrCode: input.qrCode ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    allowedNetworks,
  });

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
      qrCheckInRequired: input.qrCheckInRequired ?? false,
      qrCode: input.qrCode ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      geofenceRadiusMeters: input.geofenceRadiusMeters ?? 200,
      allowedNetworks,
      wifiName: input.wifiName || null,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'WorkLocation',
    entityId: location.id,
    legalEntityId,
    summary: `Created work location ${location.name} (${location.kind.toLowerCase()})`,
    after: onsiteAudit(location),
    actor: auth,
    ...fingerprint,
  });

  return serialize(location, { headcount: 0, includeOnsite: true });
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

  // Validated as the location will be once saved: the update merged onto what is stored.
  const allowedNetworks = input.allowedNetworks === undefined ? undefined : uniqueNetworks(input.allowedNetworks);
  const pick = <T,>(next: T | undefined, current: T) => (next === undefined ? current : next);
  assertOnsiteUsable({
    qrCheckInRequired: pick(input.qrCheckInRequired, existing.qrCheckInRequired),
    qrCode: pick(input.qrCode, existing.qrCode),
    latitude: pick(input.latitude, existing.latitude === null ? null : Number(existing.latitude)),
    longitude: pick(input.longitude, existing.longitude === null ? null : Number(existing.longitude)),
    allowedNetworks: pick(allowedNetworks, existing.allowedNetworks),
  });

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
      qrCheckInRequired: input.qrCheckInRequired,
      qrCode: input.qrCode,
      latitude: input.latitude,
      longitude: input.longitude,
      geofenceRadiusMeters: input.geofenceRadiusMeters,
      allowedNetworks,
      wifiName: input.wifiName === undefined ? undefined : input.wifiName || null,
    },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'WorkLocation',
    entityId: locationId,
    legalEntityId: existing.legalEntityId,
    summary: `Updated work location ${location.name}`,
    before: { name: existing.name, kind: existing.kind, timezone: existing.timezone, isActive: existing.isActive, ...onsiteAudit(existing) },
    after: {
      name: location.name,
      kind: location.kind,
      timezone: location.timezone,
      isActive: location.isActive,
      ...onsiteAudit(location),
      ...(existing.qrCode !== location.qrCode ? { qrCodeChanged: true } : {}),
    },
    actor: auth,
    ...fingerprint,
  });

  return serialize(location, { includeOnsite: true });
}
