import { Prisma } from '@prisma/client';
import type { CompanySettings } from '@prisma/client';
import { prisma, type TxClient } from '../db/prisma';
import { ValidationError } from '../common/errors';
import type { AuthContext } from '../common/auth-context';
import { scopedEntityId } from './access';

/**
 * The single-company layer.
 *
 * Pollux HR presents one company, but the data model still hangs policy off a
 * legal entity. This module is the only place that answers "which company do
 * you mean?" when the caller did not say, and "what is this company's policy?"
 * when a calculation needs it - so no other module ever hard-codes either.
 */

/**
 * Policy values used when an entity has no settings row yet (for example an
 * entity created through the API before anyone opened Company Settings). They
 * mirror the column defaults in schema.prisma, so a missing row and a fresh row
 * behave identically.
 */
export function defaultCompanySettings(legalEntityId: string, displayName: string): CompanySettings {
  const now = new Date();
  return {
    id: `default:${legalEntityId}`,
    legalEntityId,
    isPrimary: false,
    displayName,
    logoUrl: null,
    employeeNumberPrefix: null,
    defaultWorkScheduleId: null,
    defaultHolidayCalendarId: null,
    attendanceStartDate: null,
    lateGraceMinutes: 10,
    earlyLeaveGraceMinutes: 10,
    partialDayThresholdPercent: 50,
    missingCheckoutAfterMinutes: 120,
    overtimeEnabled: true,
    overtimeRequiresApproval: true,
    minOvertimeMinutes: 30,
    countEarlyArrivalAsOvertime: false,
    overtimeRateMultiplier: new Prisma.Decimal('1.25'),
    restDayOvertimeMultiplier: new Prisma.Decimal('1.50'),
    overtimeBase: 'BASIC',
    standardDailyHours: new Prisma.Decimal(8),
    payrollDay: 28,
    salaryDayBasis: 'FIXED_30',
    deductionBase: 'BASIC',
    absenceDeductionEnabled: true,
    unpaidLeaveDeductionEnabled: true,
    lateDeductionEnabled: false,
    payrollRequiresSeparateApprover: true,
    maxAdvanceAmount: null,
    maxAdvanceInstallments: 12,
    allowConcurrentAdvances: false,
    updatedById: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The company the single-company UI is built around: the entity whose settings
 * are flagged primary, otherwise the oldest active entity. Null only on an
 * empty database.
 */
export async function findPrimaryLegalEntityId(client: TxClient = prisma): Promise<string | null> {
  const flagged = await client.companySettings.findFirst({
    where: { isPrimary: true, legalEntity: { isActive: true } },
    orderBy: { createdAt: 'asc' },
    select: { legalEntityId: true },
  });
  if (flagged) return flagged.legalEntityId;

  const oldest = await client.legalEntity.findFirst({
    where: { isActive: true },
    orderBy: [{ establishedOn: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/**
 * The legal entity an operation applies to when the caller did not name one.
 *
 * An explicit id always wins (the API still accepts it). A scoped HR admin
 * defaults to their own entity - never someone else's. Everyone else gets the
 * primary company.
 */
export async function resolveLegalEntityId(
  auth: AuthContext | null,
  explicitId?: string | null,
  client: TxClient = prisma,
): Promise<string> {
  if (explicitId) return explicitId;

  const scope = auth ? scopedEntityId(auth) : null;
  if (scope) return scope;

  const primary = await findPrimaryLegalEntityId(client);
  if (!primary) {
    throw new ValidationError('Validation failed', {
      legalEntityId: ['No company is configured yet. Create the company record first.'],
    });
  }
  return primary;
}

/** Policy for one entity, falling back to defaults when no row exists. */
export async function getCompanySettings(
  legalEntityId: string,
  client: TxClient = prisma,
): Promise<CompanySettings> {
  const settings = await client.companySettings.findUnique({ where: { legalEntityId } });
  if (settings) return settings;

  const entity = await client.legalEntity.findUnique({ where: { id: legalEntityId }, select: { name: true } });
  return defaultCompanySettings(legalEntityId, entity?.name ?? 'Company');
}

/** Settings for several entities at once, keyed by entity id. */
export async function getCompanySettingsMap(
  legalEntityIds: string[],
  client: TxClient = prisma,
): Promise<Map<string, CompanySettings>> {
  const unique = [...new Set(legalEntityIds)];
  const [rows, entities] = await Promise.all([
    client.companySettings.findMany({ where: { legalEntityId: { in: unique } } }),
    client.legalEntity.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }),
  ]);
  const byEntity = new Map(rows.map((row) => [row.legalEntityId, row]));
  for (const entity of entities) {
    if (!byEntity.has(entity.id)) byEntity.set(entity.id, defaultCompanySettings(entity.id, entity.name));
  }
  return byEntity;
}
