import { z } from 'zod';
import { paginationSchema } from '../../common/http';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString } from '../../common/validate';

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'LATE',
  'ABSENT',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKEND',
  'PARTIAL',
  'MISSING_CHECKOUT',
] as const;

/** Statuses a list can be filtered by, including the evaluated-only ones. */
const FILTERABLE_STATUSES = [...ATTENDANCE_STATUSES, 'SCHEDULED', 'NOT_CHECKED_IN'] as const;

const clockSchema = z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:15');

export const checkInSchema = z
  .object({
    notes: optionalTrimmedString(300),
    source: z.enum(['WEB', 'MOBILE']).default('WEB'),
    // On-site evidence, for a location that requires it: the scanned QR code
    // and the position the browser reports.
    qrCode: z.string().trim().max(200).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    accuracy: z.coerce.number().min(0).max(1_000_000).optional(),
  })
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: 'Send both latitude and longitude',
    path: ['latitude'],
  });

export const checkOutSchema = checkInSchema;

/**
 * Range filters. Both ends are optional; the service defaults to the current
 * month and caps a range at 93 days so a list can never load a year of rows
 * for every employee by accident.
 */
const rangeFields = {
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
};

const subjectFilters = {
  employeeId: optionalTrimmedString(40),
  departmentId: optionalTrimmedString(40),
  workLocationId: optionalTrimmedString(40),
  workMode: z.enum(['ONSITE', 'HYBRID', 'REMOTE', 'FIELD']).optional(),
  q: optionalTrimmedString(120),
};

export const attendanceListSchema = paginationSchema.extend({
  ...rangeFields,
  ...subjectFilters,
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const parts = (Array.isArray(value) ? value : value.split(',')).map((part) => part.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    })
    .pipe(z.array(z.enum(FILTERABLE_STATUSES)).optional()),
  /** Include rest days and holidays in the list (off by default: they are noise in a register). */
  includeRestDays: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const timesheetQuerySchema = z.object({
  ...rangeFields,
  employeeId: optionalTrimmedString(40),
});

export const summaryQuerySchema = z.object({
  ...rangeFields,
  ...subjectFilters,
});

export const boardQuerySchema = z.object({
  ...subjectFilters,
});

export const manualAttendanceSchema = z
  .object({
    employeeId: requiredTrimmedString(1, 40),
    date: dateStringSchema,
    checkIn: clockSchema.optional(),
    checkOut: clockSchema.optional(),
    /** Sets the status explicitly (for example a business trip counted as PRESENT). */
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    notes: optionalTrimmedString(300),
    reason: requiredTrimmedString(3, 300),
  })
  .refine((value) => !value.checkOut || Boolean(value.checkIn), {
    message: 'A check-out needs a check-in',
    path: ['checkOut'],
  })
  .refine((value) => Boolean(value.checkIn) || Boolean(value.status), {
    message: 'Enter a check-in time or choose a status',
    path: ['checkIn'],
  });

export const correctAttendanceSchema = z.object({
  /** HH:mm in the record's own timezone; null clears it; omitted keeps it. */
  checkIn: z.union([clockSchema, z.null()]).optional(),
  checkOut: z.union([clockSchema, z.null()]).optional(),
  /** A status to force; null returns the record to its calculated status. */
  status: z.union([z.enum(ATTENDANCE_STATUSES), z.null()]).optional(),
  notes: z.union([z.string().trim().max(300), z.null()]).optional(),
  reason: requiredTrimmedString(3, 300),
});

export const recalculateSchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  employeeId: optionalTrimmedString(40),
  reason: requiredTrimmedString(3, 300),
});

export type AttendanceListQuery = z.infer<typeof attendanceListSchema>;
export type TimesheetQuery = z.infer<typeof timesheetQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type BoardQuery = z.infer<typeof boardQuerySchema>;
export type ManualAttendanceInput = z.infer<typeof manualAttendanceSchema>;
export type CorrectAttendanceInput = z.infer<typeof correctAttendanceSchema>;
export type RecalculateInput = z.infer<typeof recalculateSchema>;
