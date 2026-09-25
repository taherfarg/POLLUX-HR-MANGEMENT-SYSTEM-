import { z } from 'zod';
import { paginationSchema } from '../../common/http';
import {
  dateStringSchema,
  emailSchema,
  optionalTrimmedString,
  phoneSchema,
  requiredTrimmedString,
} from '../../common/validate';
import { timeZoneSchema } from '../settings/settings.schema';

const employeeStatus = z.enum(['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'OFFBOARDED']);
const employmentType = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']);
const contractType = z.enum(['UNLIMITED', 'LIMITED']);
const workMode = z.enum(['ONSITE', 'HYBRID', 'REMOTE', 'FIELD']);
const gender = z.enum(['MALE', 'FEMALE', 'UNDISCLOSED']);

/**
 * A reference that can be cleared: a string sets it, `null` (or an empty
 * string from a form) clears it, and omitting it leaves it untouched.
 */
const clearableId = z
  .union([z.string().trim().max(40), z.null()])
  .optional()
  .transform((value) => (value === '' ? null : value));

const clearableText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((value) => (value === '' ? null : value));

/** Accepts `?status=ACTIVE&status=PROBATION` and `?status=ACTIVE,PROBATION`. */
function csvEnum<T extends z.ZodEnum<[string, ...string[]]>>(schema: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const parts = (Array.isArray(value) ? value : value.split(','))
        .map((part) => part.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    })
    .pipe(z.array(schema).optional());
}

export const employeeQuerySchema = paginationSchema.extend({
  /** Free-text search across name, employee number, work email and job title. */
  q: optionalTrimmedString(120),
  legalEntityId: optionalTrimmedString(40),
  departmentId: optionalTrimmedString(40),
  managerId: optionalTrimmedString(40),
  workLocationId: optionalTrimmedString(40),
  workScheduleId: optionalTrimmedString(40),
  status: csvEnum(employeeStatus),
  employmentType: csvEnum(employmentType),
  workMode: csvEnum(workMode),
  /** Offboarded people are excluded by default so the directory shows the team. */
  includeOffboarded: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  sortBy: z.enum(['name', 'hireDate', 'jobTitle', 'employeeNumber', 'status']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

const personalFields = {
  firstName: requiredTrimmedString(1, 80),
  lastName: requiredTrimmedString(1, 80),
  preferredName: optionalTrimmedString(80),
  workEmail: emailSchema,
  personalEmail: emailSchema.optional(),
  phone: phoneSchema.optional(),
  dateOfBirth: dateStringSchema.optional(),
  gender: gender.optional(),
  nationality: optionalTrimmedString(80),
  addressLine: optionalTrimmedString(200),
  city: optionalTrimmedString(80),
  country: optionalTrimmedString(80),
  emergencyContactName: optionalTrimmedString(120),
  emergencyContactPhone: phoneSchema.optional(),
  emergencyContactRelation: optionalTrimmedString(60),
  avatarUrl: z.string().trim().url().max(500).optional(),
};

const employmentFields = {
  /**
   * Optional since Pollux runs as a single company: when omitted the employee
   * joins the primary company (or a scoped HR admin's own entity).
   */
  legalEntityId: optionalTrimmedString(40),
  departmentId: optionalTrimmedString(40),
  managerId: optionalTrimmedString(40),
  jobTitle: requiredTrimmedString(2, 120),
  employmentType: employmentType.default('FULL_TIME'),
  contractType: contractType.default('UNLIMITED'),
  workMode: workMode.default('ONSITE'),
  status: employeeStatus.default('PROBATION'),
  hireDate: dateStringSchema,
  probationEndDate: dateStringSchema.optional(),
  contractEndDate: dateStringSchema.optional(),
  noticePeriodDays: z.coerce.number().int().min(0).max(365).optional(),
};

/** Where and when the employee works. Every field can be cleared with null. */
const workContextFields = {
  workLocationId: clearableId,
  workScheduleId: clearableId,
  holidayCalendarId: clearableId,
  workCountryCode: z
    .union([z.string().trim().length(2).toUpperCase(), z.null()])
    .optional(),
  workCountry: clearableText(80),
  workCity: clearableText(80),
  timezone: z
    .union([timeZoneSchema, z.null()])
    .optional(),
  overtimeEligible: z.boolean().optional(),
  attendanceTracked: z.boolean().optional(),
};

/** Starting salary. Optional so HR can add an employee before pay is agreed. */
const compensationInput = z.object({
  baseSalary: z.coerce.number().nonnegative().max(100_000_000),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  payFrequency: z.enum(['MONTHLY', 'BIWEEKLY', 'ANNUAL']).default('MONTHLY'),
  housingAllowance: z.coerce.number().nonnegative().max(100_000_000).default(0),
  transportAllowance: z.coerce.number().nonnegative().max(100_000_000).default(0),
  otherAllowances: z.coerce.number().nonnegative().max(100_000_000).default(0),
  variablePayPercent: z.coerce.number().min(0).max(100).default(0),
  effectiveFrom: dateStringSchema.optional(),
  changeReason: optionalTrimmedString(200),
});

/** Optional login for the new employee. */
const accountInput = z.object({
  role: z.enum(['ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE']).default('EMPLOYEE'),
  email: emailSchema.optional(),
  /** Left blank, a temporary password is generated and returned once. */
  temporaryPassword: z.string().min(10).max(128).optional(),
  scopedLegalEntityId: optionalTrimmedString(40),
});

export const createEmployeeSchema = z
  .object({
    ...personalFields,
    ...employmentFields,
    ...workContextFields,
    compensation: compensationInput.optional(),
    account: accountInput.optional(),
  })
  .refine(
    (value) => !value.contractEndDate || value.contractEndDate > value.hireDate,
    { message: 'Contract end date must be after the hire date', path: ['contractEndDate'] },
  )
  .refine(
    (value) => value.contractType !== 'LIMITED' || Boolean(value.contractEndDate),
    { message: 'A limited contract requires an end date', path: ['contractEndDate'] },
  );

/**
 * Update deliberately omits `status`, which has its own endpoint: a status
 * change is a business event that needs a reason and writes to the timeline,
 * not a field edit.
 */
export const updateEmployeeSchema = z
  .object({
    ...personalFields,
    ...employmentFields,
    ...workContextFields,
  })
  .partial()
  .omit({ status: true })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const changeStatusSchema = z
  .object({
    status: employeeStatus,
    effectiveDate: dateStringSchema,
    reason: requiredTrimmedString(3, 300),
    exitReason: optionalTrimmedString(300),
  })
  .refine((value) => value.status !== 'OFFBOARDED' || Boolean(value.exitReason), {
    message: 'Offboarding requires an exit reason',
    path: ['exitReason'],
  });

export type EmployeeQuery = z.infer<typeof employeeQuerySchema>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
