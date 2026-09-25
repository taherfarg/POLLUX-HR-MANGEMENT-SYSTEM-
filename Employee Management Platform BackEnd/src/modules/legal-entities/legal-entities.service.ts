import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertEntityInScope, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const createLegalEntitySchema = z.object({
  code: requiredTrimmedString(2, 20).transform((value) => value.toUpperCase()),
  name: requiredTrimmedString(2, 120),
  legalName: requiredTrimmedString(2, 200),
  registrationNumber: requiredTrimmedString(2, 60),
  countryCode: z.string().trim().length(2).toUpperCase(),
  countryName: requiredTrimmedString(2, 80),
  city: requiredTrimmedString(2, 80),
  addressLine: optionalTrimmedString(200),
  currency: z.string().trim().length(3).toUpperCase(),
  timezone: requiredTrimmedString(3, 60),
  /**
   * Working days as day-of-week indexes, 0 = Sunday. This is what makes the
   * platform correct in more than one country rather than assuming Mon-Fri.
   */
  workWeek: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
  weeklyHours: z.coerce.number().min(1).max(80).default(40),
  probationMonths: z.coerce.number().int().min(0).max(24).default(6),
  noticePeriodDays: z.coerce.number().int().min(0).max(365).default(30),
  establishedOn: dateStringSchema,
  isActive: z.boolean().default(true),
});

export const updateLegalEntitySchema = createLegalEntitySchema.partial().omit({ code: true });

export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;

interface EntityRow {
  id: string;
  code: string;
  name: string;
  legalName: string;
  registrationNumber: string;
  countryCode: string;
  countryName: string;
  city: string;
  addressLine: string | null;
  currency: string;
  timezone: string;
  workWeek: number[];
  weeklyHours: Prisma.Decimal;
  probationMonths: number;
  noticePeriodDays: number;
  establishedOn: Date;
  isActive: boolean;
}

function serializeEntity(entity: EntityRow, headcount?: number) {
  return {
    id: entity.id,
    code: entity.code,
    name: entity.name,
    legalName: entity.legalName,
    registrationNumber: entity.registrationNumber,
    country: { code: entity.countryCode, name: entity.countryName },
    city: entity.city,
    addressLine: entity.addressLine,
    currency: entity.currency,
    timezone: entity.timezone,
    workWeek: entity.workWeek,
    // Spelled out so the frontend never has to know the index convention.
    workWeekLabel: [...entity.workWeek].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day]),
    weeklyHours: Number(entity.weeklyHours),
    probationMonths: entity.probationMonths,
    noticePeriodDays: entity.noticePeriodDays,
    establishedOn: entity.establishedOn.toISOString().slice(0, 10),
    isActive: entity.isActive,
    ...(headcount === undefined ? {} : { headcount }),
  };
}

/**
 * Every authenticated user can read the entity list - the frontend needs it for
 * filters and labels, and none of it is personal data. An HR_ADMIN pinned to one
 * entity still sees only that one.
 */
export async function listLegalEntities(auth: AuthContext): Promise<unknown[]> {
  const scope = scopedEntityId(auth);

  const entities = await prisma.legalEntity.findMany({
    where: scope ? { id: scope } : {},
    orderBy: { name: 'asc' },
    // Current headcount, not lifetime: an offboarded person still points at the
    // entity, so an unfiltered count made this card disagree with the dashboard,
    // the directory and this entity's own detail page - all of which already
    // exclude them.
    include: { _count: { select: { employees: { where: { status: { not: 'OFFBOARDED' } } } } } },
  });

  return entities.map((entity) => serializeEntity(entity, entity._count.employees));
}

/** Entity detail with the headcount breakdown management actually asks for. */
export async function getLegalEntity(auth: AuthContext, entityId: string): Promise<unknown> {
  assertEntityInScope(auth, entityId);

  const entity = await prisma.legalEntity.findUnique({ where: { id: entityId } });
  if (!entity) {
    throw new NotFoundError('Legal entity');
  }

  const [byStatus, byDepartment, headcount, holidayCount, leaveTypeCount] = await Promise.all([
    prisma.employee.groupBy({ by: ['status'], where: { legalEntityId: entityId }, _count: { _all: true } }),
    prisma.employee.groupBy({
      by: ['departmentId'],
      where: { legalEntityId: entityId, status: { not: 'OFFBOARDED' } },
      _count: { _all: true },
    }),
    prisma.employee.count({ where: { legalEntityId: entityId, status: { not: 'OFFBOARDED' } } }),
    prisma.holiday.count({ where: { legalEntityId: entityId } }),
    prisma.leaveType.count({ where: { legalEntityId: entityId } }),
  ]);

  const departments = await prisma.department.findMany({ select: { id: true, name: true } });
  const departmentNames = new Map(departments.map((department) => [department.id, department.name]));

  return {
    ...serializeEntity(entity, headcount),
    stats: {
      headcount,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      byDepartment: byDepartment
        .map((row) => ({
          departmentId: row.departmentId,
          name: row.departmentId ? (departmentNames.get(row.departmentId) ?? 'Unknown') : 'Unassigned',
          headcount: row._count._all,
        }))
        .sort((a, b) => b.headcount - a.headcount),
      holidays: holidayCount,
      leaveTypes: leaveTypeCount,
    },
  };
}

/**
 * Creating a legal entity is a global act - it is not inside any single entity's
 * scope - so it is restricted to a full ADMIN rather than a scoped HR_ADMIN.
 */
export async function createLegalEntity(
  auth: AuthContext,
  input: CreateLegalEntityInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  if (auth.role !== 'ADMIN') {
    throw new ForbiddenError('Only a global administrator can create a legal entity');
  }

  const entity = await prisma.legalEntity.create({
    data: {
      code: input.code,
      name: input.name,
      legalName: input.legalName,
      registrationNumber: input.registrationNumber,
      countryCode: input.countryCode,
      countryName: input.countryName,
      city: input.city,
      addressLine: input.addressLine ?? null,
      currency: input.currency,
      timezone: input.timezone,
      workWeek: input.workWeek,
      weeklyHours: new Prisma.Decimal(input.weeklyHours),
      probationMonths: input.probationMonths,
      noticePeriodDays: input.noticePeriodDays,
      establishedOn: toUtcDate(input.establishedOn),
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'CREATE',
    entityType: 'LegalEntity',
    entityId: entity.id,
    legalEntityId: entity.id,
    summary: `Created legal entity ${entity.code} (${entity.name}, ${entity.countryName})`,
    after: { code: entity.code, country: entity.countryCode },
    actor: auth,
    ...fingerprint,
  });

  return serializeEntity(entity, 0);
}

export async function updateLegalEntity(
  auth: AuthContext,
  entityId: string,
  input: UpdateLegalEntityInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  if (!isManagement(auth)) {
    throw new ForbiddenError('Only HR and administrators can edit a legal entity');
  }
  assertEntityInScope(auth, entityId);

  const existing = await prisma.legalEntity.findUnique({ where: { id: entityId } });
  if (!existing) {
    throw new NotFoundError('Legal entity');
  }

  const entity = await prisma.legalEntity.update({
    where: { id: entityId },
    data: {
      name: input.name,
      legalName: input.legalName,
      registrationNumber: input.registrationNumber,
      countryCode: input.countryCode,
      countryName: input.countryName,
      city: input.city,
      addressLine: input.addressLine,
      currency: input.currency,
      timezone: input.timezone,
      workWeek: input.workWeek,
      weeklyHours: input.weeklyHours === undefined ? undefined : new Prisma.Decimal(input.weeklyHours),
      probationMonths: input.probationMonths,
      noticePeriodDays: input.noticePeriodDays,
      establishedOn: input.establishedOn ? toUtcDate(input.establishedOn) : undefined,
      isActive: input.isActive,
    },
  });

  await recordAudit({
    action: 'UPDATE',
    entityType: 'LegalEntity',
    entityId,
    legalEntityId: entityId,
    summary: `Updated legal entity ${entity.code}`,
    actor: auth,
    ...fingerprint,
  });

  return serializeEntity(entity);
}
