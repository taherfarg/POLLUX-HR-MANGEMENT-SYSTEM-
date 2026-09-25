import { Prisma } from '@prisma/client';
import type { CompanySettings, LegalEntity } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanManageCompanySettings,
  assertEntityInScope,
  isManagement,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { findPrimaryLegalEntityId, getCompanySettings, resolveLegalEntityId } from '../../services/company';
import type { CompanySettingsUpdateInput } from './settings.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const PRODUCT_NAME = 'Pollux HR';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type EntityRow = Pick<
  LegalEntity,
  | 'id'
  | 'code'
  | 'name'
  | 'legalName'
  | 'registrationNumber'
  | 'countryCode'
  | 'countryName'
  | 'city'
  | 'addressLine'
  | 'currency'
  | 'timezone'
  | 'workWeek'
  | 'weeklyHours'
  | 'probationMonths'
  | 'noticePeriodDays'
>;

function publicView(entity: EntityRow, settings: CompanySettings) {
  return {
    legalEntityId: entity.id,
    productName: PRODUCT_NAME,
    company: {
      displayName: settings.displayName,
      legalName: entity.legalName,
      logoUrl: settings.logoUrl,
      city: entity.city,
      countryCode: entity.countryCode,
      countryName: entity.countryName,
      currency: entity.currency,
      timezone: entity.timezone,
      workWeek: entity.workWeek,
      workWeekLabel: [...entity.workWeek].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day]),
    },
    payroll: { payrollDay: settings.payrollDay },
  };
}

/** The full policy view, for HR and administrators. */
function fullView(entity: EntityRow, settings: CompanySettings) {
  const base = publicView(entity, settings);
  return {
    ...base,
    isPersisted: !settings.id.startsWith('default:'),
    company: {
      ...base.company,
      code: entity.code,
      registrationNumber: entity.registrationNumber,
      addressLine: entity.addressLine,
      weeklyHours: Number(entity.weeklyHours),
      probationMonths: entity.probationMonths,
      noticePeriodDays: entity.noticePeriodDays,
      employeeNumberPrefix: settings.employeeNumberPrefix,
    },
    attendance: {
      lateGraceMinutes: settings.lateGraceMinutes,
      earlyLeaveGraceMinutes: settings.earlyLeaveGraceMinutes,
      partialDayThresholdPercent: settings.partialDayThresholdPercent,
      missingCheckoutAfterMinutes: settings.missingCheckoutAfterMinutes,
    },
    overtime: {
      overtimeEnabled: settings.overtimeEnabled,
      overtimeRequiresApproval: settings.overtimeRequiresApproval,
      minOvertimeMinutes: settings.minOvertimeMinutes,
      countEarlyArrivalAsOvertime: settings.countEarlyArrivalAsOvertime,
      overtimeRateMultiplier: Number(settings.overtimeRateMultiplier),
      restDayOvertimeMultiplier: Number(settings.restDayOvertimeMultiplier),
      overtimeBase: settings.overtimeBase,
      standardDailyHours: Number(settings.standardDailyHours),
    },
    payroll: {
      payrollDay: settings.payrollDay,
      salaryDayBasis: settings.salaryDayBasis,
      deductionBase: settings.deductionBase,
      absenceDeductionEnabled: settings.absenceDeductionEnabled,
      unpaidLeaveDeductionEnabled: settings.unpaidLeaveDeductionEnabled,
      lateDeductionEnabled: settings.lateDeductionEnabled,
      payrollRequiresSeparateApprover: settings.payrollRequiresSeparateApprover,
    },
    advances: {
      maxAdvanceAmount: settings.maxAdvanceAmount === null ? null : Number(settings.maxAdvanceAmount),
      maxAdvanceInstallments: settings.maxAdvanceInstallments,
      allowConcurrentAdvances: settings.allowConcurrentAdvances,
    },
    defaults: {
      defaultWorkScheduleId: settings.defaultWorkScheduleId,
      defaultHolidayCalendarId: settings.defaultHolidayCalendarId,
    },
  };
}

async function loadEntity(legalEntityId: string): Promise<EntityRow> {
  const entity = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!entity) throw new NotFoundError('Company');
  return entity;
}

/**
 * Company settings for the caller. Everyone gets the public subset - company
 * name, logo, currency, timezone, working week, pay day - because the whole UI
 * needs it. HR and administrators get the full policy.
 */
export async function getSettings(auth: AuthContext, legalEntityId?: string): Promise<unknown> {
  const entityId = await resolveLegalEntityId(auth, legalEntityId ?? auth.legalEntityId);
  if (isManagement(auth)) assertEntityInScope(auth, entityId);

  const [entity, settings] = await Promise.all([loadEntity(entityId), getCompanySettings(entityId)]);
  return isManagement(auth) ? fullView(entity, settings) : publicView(entity, settings);
}

/** Login-screen branding. Deliberately tiny: nothing here is sensitive. */
export async function getPublicBranding(): Promise<{ productName: string; companyName: string | null; logoUrl: string | null }> {
  const entityId = await findPrimaryLegalEntityId();
  if (!entityId) return { productName: PRODUCT_NAME, companyName: null, logoUrl: null };
  const [entity, settings] = await Promise.all([
    prisma.legalEntity.findUnique({ where: { id: entityId }, select: { legalName: true } }),
    getCompanySettings(entityId),
  ]);
  return { productName: PRODUCT_NAME, companyName: entity?.legalName ?? settings.displayName, logoUrl: settings.logoUrl };
}

function decimalOrUndefined(value: number | undefined): Prisma.Decimal | undefined {
  return value === undefined ? undefined : new Prisma.Decimal(value);
}

/**
 * Updates the company record and its policy together, in one transaction, with
 * one audit entry holding the before/after of everything that changed.
 */
export async function updateSettings(
  auth: AuthContext,
  input: CompanySettingsUpdateInput,
  fingerprint: Fingerprint,
  legalEntityId?: string,
): Promise<unknown> {
  assertCanManageCompanySettings(auth);
  const entityId = await resolveLegalEntityId(auth, legalEntityId);
  assertEntityInScope(auth, entityId);

  const entity = await loadEntity(entityId);
  const before = fullView(entity, await getCompanySettings(entityId));

  const defaults = input.defaults ?? {};
  if (defaults.defaultWorkScheduleId) {
    const schedule = await prisma.workSchedule.findUnique({
      where: { id: defaults.defaultWorkScheduleId },
      select: { legalEntityId: true, isActive: true },
    });
    if (!schedule || schedule.legalEntityId !== entityId || !schedule.isActive) {
      throw new ValidationError('Validation failed', {
        'defaults.defaultWorkScheduleId': ['Choose an active schedule belonging to this company'],
      });
    }
  }
  if (defaults.defaultHolidayCalendarId) {
    const calendar = await prisma.holidayCalendar.findUnique({
      where: { id: defaults.defaultHolidayCalendarId },
      select: { legalEntityId: true, isActive: true },
    });
    if (!calendar || calendar.legalEntityId !== entityId || !calendar.isActive) {
      throw new ValidationError('Validation failed', {
        'defaults.defaultHolidayCalendarId': ['Choose an active holiday calendar belonging to this company'],
      });
    }
  }

  const company = input.company ?? {};
  const attendance = input.attendance ?? {};
  const overtime = input.overtime ?? {};
  const payroll = input.payroll ?? {};
  const advances = input.advances ?? {};

  const settingsData = {
    displayName: company.displayName,
    logoUrl: company.logoUrl,
    employeeNumberPrefix: company.employeeNumberPrefix,
    defaultWorkScheduleId: defaults.defaultWorkScheduleId,
    defaultHolidayCalendarId: defaults.defaultHolidayCalendarId,
    lateGraceMinutes: attendance.lateGraceMinutes,
    earlyLeaveGraceMinutes: attendance.earlyLeaveGraceMinutes,
    partialDayThresholdPercent: attendance.partialDayThresholdPercent,
    missingCheckoutAfterMinutes: attendance.missingCheckoutAfterMinutes,
    overtimeEnabled: overtime.overtimeEnabled,
    overtimeRequiresApproval: overtime.overtimeRequiresApproval,
    minOvertimeMinutes: overtime.minOvertimeMinutes,
    countEarlyArrivalAsOvertime: overtime.countEarlyArrivalAsOvertime,
    overtimeRateMultiplier: decimalOrUndefined(overtime.overtimeRateMultiplier),
    restDayOvertimeMultiplier: decimalOrUndefined(overtime.restDayOvertimeMultiplier),
    overtimeBase: overtime.overtimeBase,
    standardDailyHours: decimalOrUndefined(overtime.standardDailyHours),
    payrollDay: payroll.payrollDay,
    salaryDayBasis: payroll.salaryDayBasis,
    deductionBase: payroll.deductionBase,
    absenceDeductionEnabled: payroll.absenceDeductionEnabled,
    unpaidLeaveDeductionEnabled: payroll.unpaidLeaveDeductionEnabled,
    lateDeductionEnabled: payroll.lateDeductionEnabled,
    payrollRequiresSeparateApprover: payroll.payrollRequiresSeparateApprover,
    maxAdvanceAmount:
      advances.maxAdvanceAmount === undefined
        ? undefined
        : advances.maxAdvanceAmount === null
          ? null
          : new Prisma.Decimal(advances.maxAdvanceAmount),
    maxAdvanceInstallments: advances.maxAdvanceInstallments,
    allowConcurrentAdvances: advances.allowConcurrentAdvances,
    updatedById: auth.userId,
  };

  await prisma.$transaction(async (tx) => {
    await tx.legalEntity.update({
      where: { id: entityId },
      data: {
        legalName: company.legalName,
        registrationNumber: company.registrationNumber,
        addressLine: company.addressLine,
        city: company.city,
        countryCode: company.countryCode,
        countryName: company.countryName,
        currency: company.currency,
        timezone: company.timezone,
        workWeek: company.workWeek,
        weeklyHours: decimalOrUndefined(company.weeklyHours),
        probationMonths: company.probationMonths,
        noticePeriodDays: company.noticePeriodDays,
      },
    });

    await tx.companySettings.upsert({
      where: { legalEntityId: entityId },
      update: settingsData,
      create: {
        ...settingsData,
        legalEntityId: entityId,
        displayName: company.displayName ?? before.company.displayName,
        isPrimary: (await findPrimaryLegalEntityId(tx)) === entityId,
      },
    });
  });

  const afterEntity = await loadEntity(entityId);
  const after = fullView(afterEntity, await getCompanySettings(entityId));

  await recordAudit({
    action: 'UPDATE',
    entityType: 'CompanySettings',
    entityId,
    legalEntityId: entityId,
    summary: `Updated company settings (${changedSections(input).join(', ')})`,
    before: pickSections(before, input) as Prisma.InputJsonValue,
    after: pickSections(after, input) as Prisma.InputJsonValue,
    actor: auth,
    ...fingerprint,
  });

  return after;
}

function changedSections(input: CompanySettingsUpdateInput): string[] {
  return Object.entries(input)
    .filter(([, section]) => section && Object.keys(section).length > 0)
    .map(([name]) => name);
}

/** Only the sections that were edited go into the audit entry. */
function pickSections(view: ReturnType<typeof fullView>, input: CompanySettingsUpdateInput): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const name of changedSections(input)) {
    const section = (view as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
    const edited = (input as Record<string, Record<string, unknown> | undefined>)[name] ?? {};
    // The logo can be a large data URI; record that it changed, not the bytes.
    picked[name] = Object.fromEntries(
      Object.keys(edited).map((key) => [key, key === 'logoUrl' ? (section?.[key] ? '[image]' : null) : (section?.[key] ?? null)]),
    );
  }
  return picked;
}
