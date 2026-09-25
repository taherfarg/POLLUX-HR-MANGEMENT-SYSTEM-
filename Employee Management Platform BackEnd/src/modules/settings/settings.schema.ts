import { z } from 'zod';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { isValidTimeZone } from '../../services/timezone';

export const timeZoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(60)
  .refine(isValidTimeZone, 'Unknown timezone - use an IANA name such as Asia/Dubai');

/**
 * A logo is either an https URL or a small inline image. Inline SVG is allowed
 * because it is only ever rendered through an <img> tag, where scripts inside
 * it do not run.
 */
export const logoUrlSchema = z
  .string()
  .trim()
  .max(400_000, 'The logo is too large - use an image under about 300 KB')
  .refine(
    (value) =>
      /^https:\/\/[^\s]+$/i.test(value) || /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value),
    'Use an https:// image URL or a PNG, JPEG, WebP or SVG image',
  );

const money = z.coerce.number().nonnegative().max(100_000_000);
const multiplier = z.coerce.number().min(1).max(3);

export const companySettingsUpdateSchema = z
  .object({
    company: z
      .object({
        displayName: requiredTrimmedString(2, 120),
        legalName: requiredTrimmedString(2, 200),
        registrationNumber: requiredTrimmedString(2, 60),
        addressLine: optionalTrimmedString(200),
        city: requiredTrimmedString(2, 80),
        countryCode: z.string().trim().length(2).toUpperCase(),
        countryName: requiredTrimmedString(2, 80),
        currency: z.string().trim().length(3).toUpperCase(),
        timezone: timeZoneSchema,
        workWeek: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
        weeklyHours: z.coerce.number().min(1).max(80),
        probationMonths: z.coerce.number().int().min(0).max(24),
        noticePeriodDays: z.coerce.number().int().min(0).max(365),
        logoUrl: logoUrlSchema.nullable(),
        employeeNumberPrefix: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9]{2,6}$/, 'Use 2-6 letters or digits, e.g. PLX')
          .nullable(),
      })
      .partial()
      .optional(),
    attendance: z
      .object({
        /** No absence is inferred before this date (the go-live date). */
        attendanceStartDate: dateStringSchema.nullable(),
        lateGraceMinutes: z.coerce.number().int().min(0).max(240),
        earlyLeaveGraceMinutes: z.coerce.number().int().min(0).max(240),
        partialDayThresholdPercent: z.coerce.number().int().min(0).max(100),
        missingCheckoutAfterMinutes: z.coerce.number().int().min(15).max(24 * 60),
      })
      .partial()
      .optional(),
    overtime: z
      .object({
        overtimeEnabled: z.boolean(),
        overtimeRequiresApproval: z.boolean(),
        minOvertimeMinutes: z.coerce.number().int().min(0).max(24 * 60),
        countEarlyArrivalAsOvertime: z.boolean(),
        overtimeRateMultiplier: multiplier,
        restDayOvertimeMultiplier: multiplier,
        overtimeBase: z.enum(['BASIC', 'GROSS']),
        standardDailyHours: z.coerce.number().min(1).max(24),
      })
      .partial()
      .optional(),
    payroll: z
      .object({
        payrollDay: z.coerce.number().int().min(1).max(31),
        salaryDayBasis: z.enum(['FIXED_30', 'CALENDAR_DAYS', 'WORKING_DAYS']),
        deductionBase: z.enum(['BASIC', 'GROSS']),
        absenceDeductionEnabled: z.boolean(),
        unpaidLeaveDeductionEnabled: z.boolean(),
        lateDeductionEnabled: z.boolean(),
        payrollRequiresSeparateApprover: z.boolean(),
      })
      .partial()
      .optional(),
    advances: z
      .object({
        maxAdvanceAmount: money.nullable(),
        maxAdvanceInstallments: z.coerce.number().int().min(1).max(60),
        allowConcurrentAdvances: z.boolean(),
      })
      .partial()
      .optional(),
    defaults: z
      .object({
        defaultWorkScheduleId: z.string().trim().min(1).max(40).nullable(),
        defaultHolidayCalendarId: z.string().trim().min(1).max(40).nullable(),
      })
      .partial()
      .optional(),
  })
  .refine((value) => Object.values(value).some((section) => section && Object.keys(section).length > 0), {
    message: 'No settings to update',
  });

export type CompanySettingsUpdateInput = z.infer<typeof companySettingsUpdateSchema>;
