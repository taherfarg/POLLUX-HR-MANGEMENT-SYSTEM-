import type { Prisma, WorkMode } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString } from '../../common/validate';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertEntityInScope, isManagement, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { resolveLegalEntityId } from '../../services/company';
import { sum, ZERO, type Money } from '../../services/money';
import { toDateKey } from '../../services/working-days';
import { loadAttendanceDays, serializeDay, totalsFor, type AttendanceDay } from '../attendance/attendance.days';
import { labelOf, resolveRange, resolveSubjects, type SubjectRow } from '../attendance/attendance.service';
import type { ReportColumn, ReportDocument, ReportRow } from './report.export';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Reports. Every report is built from the same services the screens use - the
 * attendance reports from the one attendance evaluation path, the payroll
 * report from the stored payroll records - so a report never disagrees with
 * the page it summarises.
 *
 * Who may run what:
 *   TEAM reports (attendance, lateness, absence, overtime minutes, leave,
 *   leave balances): HR and administrators for their scope, managers for
 *   themselves and their direct reports.
 *   HR reports (payroll, salary advances, the employee list): HR and
 *   administrators only. Opening or exporting a pay report is audited.
 * Employees have their own pages (My attendance, My pay) instead.
 */

export const REPORT_TYPES = [
  'attendance',
  'late',
  'absence',
  'overtime',
  'leave',
  'leave-balance',
  'payroll',
  'advances',
  'employees',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

interface ReportDefinition {
  title: string;
  description: string;
  audience: 'TEAM' | 'HR';
  /** Reveals pay: opening it is audited, not only exporting it. */
  sensitive: boolean;
  /** Which filters the report understands, so the UI can show the right ones. */
  filters: ('range' | 'year' | 'employee' | 'department' | 'workLocation' | 'workMode' | 'status' | 'period')[];
}

export const REPORTS: Record<ReportType, ReportDefinition> = {
  attendance: {
    title: 'Attendance report',
    description: 'Days present, late, absent and on leave, worked hours and overtime per employee.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['range', 'employee', 'department', 'workLocation', 'workMode'],
  },
  late: {
    title: 'Late arrivals report',
    description: 'Every late arrival with the scheduled start, the check-in and the minutes late.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['range', 'employee', 'department', 'workLocation', 'workMode'],
  },
  absence: {
    title: 'Absence report',
    description: 'Every working day without a check-in or approved leave.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['range', 'employee', 'department', 'workLocation', 'workMode'],
  },
  overtime: {
    title: 'Overtime report',
    description: 'Overtime entries with minutes, rate multiplier, status and the payroll that paid them.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['range', 'employee', 'department', 'workLocation', 'status'],
  },
  leave: {
    title: 'Leave report',
    description: 'Leave requests overlapping the period, by type and status.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['range', 'employee', 'department', 'workLocation', 'status'],
  },
  'leave-balance': {
    title: 'Leave balance report',
    description: 'Entitlement, carried-over, used, pending and available days for the year.',
    audience: 'TEAM',
    sensitive: false,
    filters: ['year', 'employee', 'department', 'workLocation'],
  },
  payroll: {
    title: 'Payroll report',
    description: 'Earnings, deductions and net salary per employee for the payroll months in the period.',
    audience: 'HR',
    sensitive: true,
    filters: ['range', 'period', 'employee', 'department', 'status'],
  },
  advances: {
    title: 'Salary advance report',
    description: 'Advances requested in the period with repaid and outstanding amounts.',
    audience: 'HR',
    sensitive: true,
    filters: ['range', 'employee', 'department', 'status'],
  },
  employees: {
    title: 'Employee report',
    description: 'The employee list with department, manager, work location, mode and status. No pay data.',
    audience: 'HR',
    sensitive: false,
    filters: ['employee', 'department', 'workLocation', 'workMode', 'status'],
  },
};

export const reportQuerySchema = z.object({
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  employeeId: optionalTrimmedString(40),
  departmentId: optionalTrimmedString(40),
  workLocationId: optionalTrimmedString(40),
  workMode: z.enum(['ONSITE', 'HYBRID', 'REMOTE', 'FIELD']).optional(),
  status: optionalTrimmedString(30),
  periodId: optionalTrimmedString(40),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

function canRun(auth: AuthContext, definition: ReportDefinition): boolean {
  if (isManagement(auth)) return true;
  return definition.audience === 'TEAM' && auth.role === 'MANAGER' && Boolean(auth.employeeId);
}

/** The reports this caller may run - drives the Reports page. */
export function listReports(auth: AuthContext) {
  if (!isManagement(auth) && auth.role !== 'MANAGER') {
    throw new ForbiddenError('Reports are available to managers, HR and administrators');
  }
  return REPORT_TYPES.filter((type) => canRun(auth, REPORTS[type])).map((type) => ({
    type,
    title: REPORTS[type].title,
    description: REPORTS[type].description,
    filters: REPORTS[type].filters,
    sensitive: REPORTS[type].sensitive,
    teamOnly: !isManagement(auth),
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LONG_RANGE_DAYS = 366;

/** Leave, overtime, advance and payroll reports may span up to a year. Defaults to this year. */
function resolveLongRange(from: string | undefined, to: string | undefined, now: Date): { fromKey: string; toKey: string } {
  const year = now.getUTCFullYear();
  const fromKey = from ?? `${year}-01-01`;
  const toKey = to ?? (from ? addDaysKey(fromKey, 364) : `${year}-12-31`);
  if (toKey < fromKey) {
    throw new ValidationError('Validation failed', { to: ['The end date cannot be before the start date'] });
  }
  const days = Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000) + 1;
  if (days > MAX_LONG_RANGE_DAYS) {
    throw new ValidationError('Validation failed', { to: [`Choose a range of at most ${MAX_LONG_RANGE_DAYS} days`] });
  }
  return { fromKey, toKey };
}

function addDaysKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const utc = (dateKey: string) => new Date(`${dateKey}T00:00:00.000Z`);

function formatDate(dateKey: string): string {
  const date = utc(dateKey);
  return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const hours = (minutes: number) => (minutes / 60).toFixed(2);
const amount = (value: Money | null | undefined) => (value ? value.toFixed(2) : '0.00');

/** The employee filter every HR report applies, narrowed to the caller's scope. */
function hrEmployeeWhere(auth: AuthContext, query: ReportQuery): Prisma.EmployeeWhereInput {
  const scope = scopedEntityId(auth);
  return {
    AND: [
      scope ? { legalEntityId: scope } : {},
      query.employeeId ? { id: query.employeeId } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.workLocationId ? { workLocationId: query.workLocationId } : {},
      query.workMode ? { workMode: query.workMode as WorkMode } : {},
    ],
  };
}

function subjectFilters(query: ReportQuery) {
  return {
    employeeId: query.employeeId,
    departmentId: query.departmentId,
    workLocationId: query.workLocationId,
    workMode: query.workMode,
  };
}

const employeeColumns: ReportColumn[] = [
  { key: 'employeeNumber', label: 'Employee no.', width: 1 },
  { key: 'employee', label: 'Employee', width: 1.8 },
  { key: 'department', label: 'Department', width: 1.3 },
];

function employeeCells(subject: SubjectRow): ReportRow {
  const label = labelOf(subject);
  return {
    employeeNumber: label.employeeNumber,
    employee: label.fullName,
    department: label.department?.name ?? null,
  };
}

interface BuiltReport {
  columns: ReportColumn[];
  rows: ReportRow[];
  summary: { label: string; value: string }[];
  rangeLabel: string;
  /** Entity the audit entry is tagged with. */
  legalEntityId: string | null;
}

// ---------------------------------------------------------------------------
// Attendance-based reports
// ---------------------------------------------------------------------------

async function loadTeamDays(auth: AuthContext, query: ReportQuery, now: Date) {
  const { fromKey, toKey } = resolveRange(query.from, query.to, now);
  const subjects = await resolveSubjects(auth, subjectFilters(query), fromKey, toKey);
  const loaded = await loadAttendanceDays(
    subjects.map((subject) => subject.id),
    fromKey,
    toKey,
    now,
  );
  return { fromKey, toKey, subjects, loaded };
}

async function attendanceReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey, subjects, loaded } = await loadTeamDays(auth, query, now);
  const rows = subjects.map((subject) => {
    const totals = totalsFor(loaded.get(subject.id)?.days ?? []);
    return {
      ...employeeCells(subject),
      workLocation: subject.workLocation?.name ?? null,
      workMode: subject.workMode,
      scheduledDays: totals.scheduledDays,
      presentDays: totals.presentDays,
      lateDays: totals.lateDays,
      absentDays: totals.absentDays,
      leaveDays: totals.leaveDays,
      holidays: totals.holidays,
      workedHours: hours(totals.workedMinutes),
      lateMinutes: totals.lateMinutes,
      overtimeMinutes: totals.overtimeMinutes,
      missingCheckouts: totals.missingCheckouts,
    };
  });
  const all = totalsFor([...loaded.values()].flatMap((entry) => entry.days));
  return {
    columns: [
      ...employeeColumns,
      { key: 'workLocation', label: 'Work location', width: 1.2 },
      { key: 'workMode', label: 'Mode', width: 0.8 },
      { key: 'scheduledDays', label: 'Working days', type: 'number', width: 0.8 },
      { key: 'presentDays', label: 'Present', type: 'number', width: 0.7 },
      { key: 'lateDays', label: 'Late', type: 'number', width: 0.6 },
      { key: 'absentDays', label: 'Absent', type: 'number', width: 0.7 },
      { key: 'leaveDays', label: 'Leave', type: 'number', width: 0.6 },
      { key: 'holidays', label: 'Holidays', type: 'number', width: 0.7 },
      { key: 'workedHours', label: 'Worked (h)', type: 'number', width: 0.8 },
      { key: 'lateMinutes', label: 'Late (min)', type: 'minutes', width: 0.8 },
      { key: 'overtimeMinutes', label: 'Overtime (min)', type: 'minutes', width: 0.9 },
      { key: 'missingCheckouts', label: 'Missing check-outs', type: 'number', width: 0.9 },
    ],
    rows,
    summary: [
      { label: 'Employees', value: String(subjects.length) },
      { label: 'Present days', value: String(all.presentDays) },
      { label: 'Late arrivals', value: `${all.lateDays} (${all.lateMinutes} min)` },
      { label: 'Absent days', value: String(all.absentDays) },
      { label: 'Leave days', value: String(all.leaveDays) },
      { label: 'Worked hours', value: hours(all.workedMinutes) },
      { label: 'Overtime', value: `${hours(all.overtimeMinutes)} h` },
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: null,
  };
}

function dayRows(
  subjects: SubjectRow[],
  loaded: Map<string, { days: AttendanceDay[] }>,
  keep: (day: AttendanceDay) => boolean,
): { subject: SubjectRow; day: AttendanceDay }[] {
  const rows: { subject: SubjectRow; day: AttendanceDay }[] = [];
  for (const subject of subjects) {
    for (const day of loaded.get(subject.id)?.days ?? []) {
      if (keep(day)) rows.push({ subject, day });
    }
  }
  return rows.sort(
    (a, b) => b.day.plan.dateKey.localeCompare(a.day.plan.dateKey) || a.subject.firstName.localeCompare(b.subject.firstName),
  );
}

async function lateReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey, subjects, loaded } = await loadTeamDays(auth, query, now);
  const rows = dayRows(subjects, loaded, (day) => day.evaluation.lateMinutes > 0);
  const totalMinutes = rows.reduce((total, row) => total + row.day.evaluation.lateMinutes, 0);
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 0.9 },
      ...employeeColumns,
      { key: 'timezone', label: 'Timezone', width: 1 },
      { key: 'scheduledStart', label: 'Scheduled start', width: 0.9 },
      { key: 'checkIn', label: 'Check-in', width: 0.8 },
      { key: 'lateMinutes', label: 'Late (min)', type: 'minutes', width: 0.8 },
      { key: 'status', label: 'Status', width: 0.9 },
    ],
    rows: rows.map(({ subject, day }) => {
      const view = serializeDay(day);
      return {
        date: day.plan.dateKey,
        ...employeeCells(subject),
        timezone: String(view.timezone),
        scheduledStart: (view.scheduledStartLocal as string | null) ?? null,
        checkIn: (view.checkInLocal as string | null) ?? null,
        lateMinutes: day.evaluation.lateMinutes,
        status: day.evaluation.status,
      };
    }),
    summary: [
      { label: 'Late arrivals', value: String(rows.length) },
      { label: 'Employees late at least once', value: String(new Set(rows.map((row) => row.subject.id)).size) },
      { label: 'Total minutes late', value: String(totalMinutes) },
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: null,
  };
}

async function absenceReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey, subjects, loaded } = await loadTeamDays(auth, query, now);
  const rows = dayRows(subjects, loaded, (day) => day.evaluation.absentDays > 0);
  const totalDays = rows.reduce((total, row) => total + row.day.evaluation.absentDays, 0);
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 0.9 },
      { key: 'dayName', label: 'Day', width: 0.8 },
      ...employeeColumns,
      { key: 'workLocation', label: 'Work location', width: 1.2 },
      { key: 'absentDays', label: 'Days', type: 'number', width: 0.5 },
      { key: 'note', label: 'Note', width: 1.4 },
    ],
    rows: rows.map(({ subject, day }) => ({
      date: day.plan.dateKey,
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day.plan.dayOfWeek] ?? null,
      ...employeeCells(subject),
      workLocation: subject.workLocation?.name ?? null,
      absentDays: day.evaluation.absentDays,
      note: day.plan.halfLeave ? 'Half day - the other half was leave' : day.record?.statusOverridden ? 'Set by HR' : null,
    })),
    summary: [
      { label: 'Absent days', value: String(Number(totalDays.toFixed(2))) },
      { label: 'Employees absent at least once', value: String(new Set(rows.map((row) => row.subject.id)).size) },
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: null,
  };
}

async function overtimeReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey } = resolveLongRange(query.from, query.to, now);
  const subjects = await resolveSubjects(auth, subjectFilters(query), fromKey, toKey);
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const status = query.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | undefined;
  if (status && !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
    throw new ValidationError('Validation failed', { status: ['Unknown overtime status'] });
  }

  const entries = await prisma.overtimeEntry.findMany({
    where: {
      employeeId: { in: [...byId.keys()] },
      date: { gte: utc(fromKey), lte: utc(toKey) },
      ...(status ? { status } : {}),
    },
    include: { payrollItem: { select: { record: { select: { period: { select: { name: true } } } } } } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  const approvedMinutes = entries.filter((entry) => entry.status === 'APPROVED').reduce((total, entry) => total + entry.minutes, 0);
  const pendingMinutes = entries.filter((entry) => entry.status === 'PENDING').reduce((total, entry) => total + entry.minutes, 0);
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 0.9 },
      ...employeeColumns,
      { key: 'dayType', label: 'Day', width: 0.9 },
      { key: 'minutes', label: 'Minutes', type: 'minutes', width: 0.7 },
      { key: 'hours', label: 'Hours', type: 'number', width: 0.6 },
      { key: 'multiplier', label: 'Rate', type: 'number', width: 0.5 },
      { key: 'source', label: 'Source', width: 0.8 },
      { key: 'status', label: 'Status', width: 0.8 },
      { key: 'paidIn', label: 'Paid in', width: 1 },
    ],
    rows: entries.map((entry) => {
      const subject = byId.get(entry.employeeId) as SubjectRow;
      return {
        date: toDateKey(entry.date),
        ...employeeCells(subject),
        dayType: entry.dayType === 'WORKING_DAY' ? 'Working day' : entry.dayType === 'HOLIDAY' ? 'Holiday' : 'Rest day',
        minutes: entry.minutes,
        hours: hours(entry.minutes),
        multiplier: entry.rateMultiplier.toString(),
        source: entry.source,
        status: entry.status,
        paidIn: entry.payrollItem?.record.period.name ?? null,
      };
    }),
    summary: [
      { label: 'Entries', value: String(entries.length) },
      { label: 'Approved', value: `${hours(approvedMinutes)} h` },
      { label: 'Pending approval', value: `${hours(pendingMinutes)} h` },
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: null,
  };
}

async function leaveReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey } = resolveLongRange(query.from, query.to, now);
  const subjects = await resolveSubjects(auth, subjectFilters(query), fromKey, toKey);
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const status = query.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | undefined;
  if (status && !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
    throw new ValidationError('Validation failed', { status: ['Unknown request status'] });
  }

  const leaves = await prisma.leaveRequestDetail.findMany({
    where: {
      startDate: { lte: utc(toKey) },
      endDate: { gte: utc(fromKey) },
      request: { employeeId: { in: [...byId.keys()] }, ...(status ? { status } : {}) },
    },
    include: {
      leaveType: { select: { name: true, isPaid: true } },
      request: { select: { reference: true, status: true, submittedAt: true, employeeId: true } },
    },
    orderBy: { startDate: 'desc' },
  });

  const approvedDays = sum(leaves.filter((leave) => leave.request.status === 'APPROVED').map((leave) => leave.workingDays));
  return {
    columns: [
      { key: 'reference', label: 'Reference', width: 1 },
      ...employeeColumns,
      { key: 'leaveType', label: 'Leave type', width: 1.2 },
      { key: 'paid', label: 'Paid', width: 0.5 },
      { key: 'startDate', label: 'From', type: 'date', width: 0.9 },
      { key: 'endDate', label: 'To', type: 'date', width: 0.9 },
      { key: 'days', label: 'Days', type: 'number', width: 0.5 },
      { key: 'status', label: 'Status', width: 0.8 },
      { key: 'submittedOn', label: 'Submitted', type: 'date', width: 0.9 },
    ],
    rows: leaves.map((leave) => ({
      reference: leave.request.reference,
      ...employeeCells(byId.get(leave.request.employeeId) as SubjectRow),
      leaveType: leave.leaveType.name,
      paid: leave.leaveType.isPaid ? 'Yes' : 'No',
      startDate: toDateKey(leave.startDate),
      endDate: toDateKey(leave.endDate),
      days: leave.workingDays.toString(),
      status: leave.request.status,
      submittedOn: toDateKey(leave.request.submittedAt),
    })),
    summary: [
      { label: 'Requests', value: String(leaves.length) },
      { label: 'Approved working days', value: approvedDays.toString() },
      { label: 'Pending requests', value: String(leaves.filter((leave) => leave.request.status === 'PENDING').length) },
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: null,
  };
}

async function leaveBalanceReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const year = query.year ?? now.getUTCFullYear();
  const subjects = await resolveSubjects(auth, subjectFilters(query), `${year}-01-01`, `${year}-12-31`);
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const balances = await prisma.leaveBalance.findMany({
    where: { year, employeeId: { in: [...byId.keys()] } },
    include: { leaveType: { select: { name: true } } },
  });
  balances.sort((a, b) => {
    const left = byId.get(a.employeeId) as SubjectRow;
    const right = byId.get(b.employeeId) as SubjectRow;
    return left.firstName.localeCompare(right.firstName) || left.lastName.localeCompare(right.lastName) || a.leaveType.name.localeCompare(b.leaveType.name);
  });

  const available = (balance: (typeof balances)[number]) =>
    balance.entitledDays.plus(balance.carriedOverDays).minus(balance.usedDays).minus(balance.pendingDays);
  return {
    columns: [
      ...employeeColumns,
      { key: 'leaveType', label: 'Leave type', width: 1.3 },
      { key: 'entitled', label: 'Entitlement', type: 'number', width: 0.8 },
      { key: 'carried', label: 'Carried over', type: 'number', width: 0.8 },
      { key: 'used', label: 'Used', type: 'number', width: 0.6 },
      { key: 'pending', label: 'Pending', type: 'number', width: 0.7 },
      { key: 'available', label: 'Available', type: 'number', width: 0.7 },
    ],
    rows: balances.map((balance) => ({
      ...employeeCells(byId.get(balance.employeeId) as SubjectRow),
      leaveType: balance.leaveType.name,
      entitled: balance.entitledDays.toString(),
      carried: balance.carriedOverDays.toString(),
      used: balance.usedDays.toString(),
      pending: balance.pendingDays.toString(),
      available: available(balance).toString(),
    })),
    summary: [
      { label: 'Employees', value: String(new Set(balances.map((balance) => balance.employeeId)).size) },
      { label: 'Days used', value: sum(balances.map((balance) => balance.usedDays)).toString() },
      { label: 'Days available', value: sum(balances.map(available)).toString() },
    ],
    rangeLabel: `Year ${year}`,
    legalEntityId: null,
  };
}

// ---------------------------------------------------------------------------
// HR reports
// ---------------------------------------------------------------------------

const PAYROLL_STATUSES = ['DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID'] as const;

async function payrollReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const scope = scopedEntityId(auth);
  let periodWhere: Prisma.PayrollPeriodWhereInput;
  let rangeLabel: string;

  if (query.periodId) {
    const period = await prisma.payrollPeriod.findUnique({ where: { id: query.periodId } });
    if (!period) throw new NotFoundError('Payroll period');
    assertEntityInScope(auth, period.legalEntityId);
    periodWhere = { id: period.id };
    rangeLabel = period.name;
  } else {
    const { fromKey, toKey } = resolveLongRange(query.from, query.to, now);
    const status = query.status as (typeof PAYROLL_STATUSES)[number] | undefined;
    if (status && !PAYROLL_STATUSES.includes(status)) {
      throw new ValidationError('Validation failed', { status: ['Unknown payroll status'] });
    }
    // Months whose first day falls in the range.
    periodWhere = {
      ...(scope ? { legalEntityId: scope } : {}),
      startDate: { gte: utc(`${fromKey.slice(0, 7)}-01`), lte: utc(toKey) },
      status: status ? status : { not: 'CANCELLED' },
    };
    rangeLabel = `${formatDate(fromKey)} - ${formatDate(toKey)}`;
  }

  const records = await prisma.payrollRecord.findMany({
    where: {
      period: periodWhere,
      employee: hrEmployeeWhere(auth, { ...query, workMode: undefined }),
    },
    include: {
      items: true,
      period: { select: { name: true, year: true, month: true, status: true, legalEntityId: true } },
    },
    orderBy: [{ period: { year: 'asc' } }, { period: { month: 'asc' } }, { employeeNumber: 'asc' }],
  });

  const pick = (record: (typeof records)[number], types: string[]) =>
    sum(record.items.filter((item) => types.includes(item.type)).map((item) => item.amount));

  const totalsByCurrency = new Map<string, { gross: Money; deductions: Money; net: Money; count: number }>();
  const rows = records.map((record) => {
    const bucket = totalsByCurrency.get(record.currency) ?? { gross: ZERO, deductions: ZERO, net: ZERO, count: 0 };
    bucket.gross = bucket.gross.plus(record.grossEarnings);
    bucket.deductions = bucket.deductions.plus(record.totalDeductions);
    bucket.net = bucket.net.plus(record.netSalary);
    bucket.count += 1;
    totalsByCurrency.set(record.currency, bucket);

    const allowances = pick(record, ['HOUSING_ALLOWANCE', 'TRANSPORT_ALLOWANCE', 'OTHER_ALLOWANCE', 'ALLOWANCE']);
    const basic = pick(record, ['BASIC_SALARY']);
    const overtime = pick(record, ['OVERTIME']);
    const advance = pick(record, ['ADVANCE_DEDUCTION']);
    const attendance = pick(record, ['ABSENCE', 'UNPAID_LEAVE', 'LATE_DEDUCTION']);
    return {
      period: record.period.name,
      employeeNumber: record.employeeNumber,
      employee: record.employeeName,
      department: record.departmentName,
      currency: record.currency,
      basic: amount(basic),
      allowances: amount(allowances),
      overtime: amount(overtime),
      otherEarnings: amount(record.grossEarnings.minus(basic).minus(allowances).minus(overtime)),
      gross: amount(record.grossEarnings),
      advances: amount(advance),
      attendanceDeductions: amount(attendance),
      otherDeductions: amount(record.totalDeductions.minus(advance).minus(attendance)),
      deductions: amount(record.totalDeductions),
      net: amount(record.netSalary),
      status: record.period.status,
    };
  });

  const legalEntityIds = [...new Set(records.map((record) => record.period.legalEntityId))];
  return {
    columns: [
      { key: 'period', label: 'Month', width: 1 },
      ...employeeColumns,
      { key: 'currency', label: 'Cur.', width: 0.45 },
      { key: 'basic', label: 'Basic', type: 'money', width: 0.9 },
      { key: 'allowances', label: 'Allowances', type: 'money', width: 0.9 },
      { key: 'overtime', label: 'Overtime', type: 'money', width: 0.8 },
      { key: 'otherEarnings', label: 'Bonus & other', type: 'money', width: 0.9 },
      { key: 'gross', label: 'Gross', type: 'money', width: 0.9 },
      { key: 'advances', label: 'Advances', type: 'money', width: 0.8 },
      { key: 'attendanceDeductions', label: 'Absence & leave', type: 'money', width: 0.9 },
      { key: 'otherDeductions', label: 'Other deductions', type: 'money', width: 0.9 },
      { key: 'deductions', label: 'Deductions', type: 'money', width: 0.9 },
      { key: 'net', label: 'Net', type: 'money', width: 0.9 },
      { key: 'status', label: 'Status', width: 0.8 },
    ],
    rows,
    // Totals per currency - amounts in different currencies are never added up.
    summary: [
      { label: 'Payslips', value: String(records.length) },
      ...[...totalsByCurrency.entries()].flatMap(([currency, totals]) => [
        { label: `Gross (${currency})`, value: totals.gross.toFixed(2) },
        { label: `Deductions (${currency})`, value: totals.deductions.toFixed(2) },
        { label: `Net (${currency})`, value: totals.net.toFixed(2) },
      ]),
    ],
    rangeLabel,
    legalEntityId: legalEntityIds.length === 1 ? (legalEntityIds[0] as string) : scope,
  };
}

const ADVANCE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;

async function advancesReport(auth: AuthContext, query: ReportQuery, now: Date): Promise<BuiltReport> {
  const { fromKey, toKey } = resolveLongRange(query.from, query.to, now);
  const status = query.status as (typeof ADVANCE_STATUSES)[number] | undefined;
  if (status && !ADVANCE_STATUSES.includes(status)) {
    throw new ValidationError('Validation failed', { status: ['Unknown advance status'] });
  }
  const scope = scopedEntityId(auth);
  const advances = await prisma.salaryAdvance.findMany({
    where: {
      ...(scope ? { legalEntityId: scope } : {}),
      requestDate: { gte: utc(fromKey), lt: utc(addDaysKey(toKey, 1)) },
      ...(status ? { status } : {}),
      employee: hrEmployeeWhere(auth, { ...query, workMode: undefined }),
    },
    include: {
      installments: { select: { status: true, amount: true } },
      employee: { select: { employeeNumber: true, firstName: true, lastName: true, department: { select: { name: true } } } },
    },
    orderBy: { requestDate: 'desc' },
  });

  const outstanding = new Map<string, Money>();
  const rows = advances.map((advance) => {
    const principal = advance.approvedAmount ?? advance.requestedAmount;
    const repaid = sum(advance.installments.filter((row) => row.status === 'DEDUCTED').map((row) => row.amount));
    const remaining = ['PAID', 'ACTIVE', 'COMPLETED'].includes(advance.status)
      ? advance.remainingAmount
      : advance.status === 'APPROVED'
        ? principal
        : ZERO;
    if (['PAID', 'ACTIVE'].includes(advance.status)) {
      outstanding.set(advance.currency, (outstanding.get(advance.currency) ?? ZERO).plus(remaining));
    }
    return {
      reference: advance.reference,
      employeeNumber: advance.employee.employeeNumber,
      employee: `${advance.employee.firstName} ${advance.employee.lastName}`,
      department: advance.employee.department?.name ?? null,
      currency: advance.currency,
      requested: amount(advance.requestedAmount),
      approved: advance.approvedAmount ? amount(advance.approvedAmount) : null,
      installments: advance.numberOfInstallments,
      repaid: amount(repaid),
      remaining: amount(remaining),
      status: advance.status,
      requestedOn: toDateKey(advance.requestDate),
      paidOn: advance.paidAt ? toDateKey(advance.paidAt) : null,
    };
  });

  return {
    columns: [
      { key: 'reference', label: 'Reference', width: 1.1 },
      ...employeeColumns,
      { key: 'currency', label: 'Cur.', width: 0.45 },
      { key: 'requested', label: 'Requested', type: 'money', width: 0.9 },
      { key: 'approved', label: 'Approved', type: 'money', width: 0.9 },
      { key: 'installments', label: 'Instalments', type: 'number', width: 0.7 },
      { key: 'repaid', label: 'Repaid', type: 'money', width: 0.9 },
      { key: 'remaining', label: 'Outstanding', type: 'money', width: 0.9 },
      { key: 'status', label: 'Status', width: 0.8 },
      { key: 'requestedOn', label: 'Requested on', type: 'date', width: 0.9 },
      { key: 'paidOn', label: 'Paid on', type: 'date', width: 0.9 },
    ],
    rows,
    summary: [
      { label: 'Advances', value: String(advances.length) },
      { label: 'Pending decision', value: String(advances.filter((advance) => advance.status === 'PENDING').length) },
      ...[...outstanding.entries()].map(([currency, value]) => ({ label: `Outstanding (${currency})`, value: value.toFixed(2) })),
    ],
    rangeLabel: `${formatDate(fromKey)} - ${formatDate(toKey)}`,
    legalEntityId: scope,
  };
}

const EMPLOYEE_STATUSES = ['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'OFFBOARDED'] as const;

async function employeesReport(auth: AuthContext, query: ReportQuery): Promise<BuiltReport> {
  const status = query.status as (typeof EMPLOYEE_STATUSES)[number] | 'ALL' | undefined;
  if (status && status !== 'ALL' && !EMPLOYEE_STATUSES.includes(status)) {
    throw new ValidationError('Validation failed', { status: ['Unknown employee status'] });
  }
  const employees = await prisma.employee.findMany({
    where: {
      AND: [
        hrEmployeeWhere(auth, query),
        status === 'ALL' ? {} : status ? { status } : { status: { not: 'OFFBOARDED' } },
      ],
    },
    select: {
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      workEmail: true,
      employmentType: true,
      workMode: true,
      status: true,
      hireDate: true,
      department: { select: { name: true } },
      workLocation: { select: { name: true } },
      manager: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });

  const byMode = new Map<string, number>();
  for (const employee of employees) byMode.set(employee.workMode, (byMode.get(employee.workMode) ?? 0) + 1);
  return {
    columns: [
      { key: 'employeeNumber', label: 'Employee no.', width: 0.9 },
      { key: 'employee', label: 'Employee', width: 1.6 },
      { key: 'jobTitle', label: 'Job title', width: 1.4 },
      { key: 'department', label: 'Department', width: 1.2 },
      { key: 'manager', label: 'Manager', width: 1.3 },
      { key: 'workLocation', label: 'Work location', width: 1.2 },
      { key: 'workMode', label: 'Mode', width: 0.7 },
      { key: 'employmentType', label: 'Type', width: 0.9 },
      { key: 'status', label: 'Status', width: 0.8 },
      { key: 'hireDate', label: 'Hired', type: 'date', width: 0.8 },
      { key: 'workEmail', label: 'Work email', width: 1.8 },
    ],
    rows: employees.map((employee) => ({
      employeeNumber: employee.employeeNumber,
      employee: `${employee.firstName} ${employee.lastName}`,
      jobTitle: employee.jobTitle,
      department: employee.department?.name ?? null,
      manager: employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : null,
      workLocation: employee.workLocation?.name ?? null,
      workMode: employee.workMode,
      employmentType: employee.employmentType,
      status: employee.status,
      hireDate: toDateKey(employee.hireDate),
      workEmail: employee.workEmail,
    })),
    summary: [
      { label: 'Employees', value: String(employees.length) },
      ...[...byMode.entries()].map(([mode, count]) => ({ label: `Work mode ${mode.toLowerCase()}`, value: String(count) })),
    ],
    rangeLabel: status === 'ALL' ? 'All employees' : status ? `Status ${status.toLowerCase()}` : 'Current employees',
    legalEntityId: scopedEntityId(auth),
  };
}

// ---------------------------------------------------------------------------
// Running a report
// ---------------------------------------------------------------------------

async function filterLabel(query: ReportQuery): Promise<string[]> {
  const parts: string[] = [];
  const [employee, department, location] = await Promise.all([
    query.employeeId
      ? prisma.employee.findUnique({ where: { id: query.employeeId }, select: { firstName: true, lastName: true } })
      : null,
    query.departmentId ? prisma.department.findUnique({ where: { id: query.departmentId }, select: { name: true } }) : null,
    query.workLocationId ? prisma.workLocation.findUnique({ where: { id: query.workLocationId }, select: { name: true } }) : null,
  ]);
  if (employee) parts.push(`Employee: ${employee.firstName} ${employee.lastName}`);
  if (department) parts.push(`Department: ${department.name}`);
  if (location) parts.push(`Location: ${location.name}`);
  if (query.workMode) parts.push(`Mode: ${query.workMode.toLowerCase()}`);
  if (query.status) parts.push(`Status: ${query.status.toLowerCase()}`);
  return parts;
}

export async function runReport(
  auth: AuthContext,
  type: ReportType,
  query: ReportQuery,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<ReportDocument & { type: ReportType; teamOnly: boolean }> {
  const definition = REPORTS[type];
  if (!canRun(auth, definition)) {
    throw new ForbiddenError(
      definition.audience === 'HR'
        ? 'This report is restricted to HR and administrators'
        : 'Reports are available to managers, HR and administrators',
    );
  }

  let built: BuiltReport;
  switch (type) {
    case 'attendance':
      built = await attendanceReport(auth, query, now);
      break;
    case 'late':
      built = await lateReport(auth, query, now);
      break;
    case 'absence':
      built = await absenceReport(auth, query, now);
      break;
    case 'overtime':
      built = await overtimeReport(auth, query, now);
      break;
    case 'leave':
      built = await leaveReport(auth, query, now);
      break;
    case 'leave-balance':
      built = await leaveBalanceReport(auth, query, now);
      break;
    case 'payroll':
      built = await payrollReport(auth, query, now);
      break;
    case 'advances':
      built = await advancesReport(auth, query, now);
      break;
    case 'employees':
      built = await employeesReport(auth, query);
      break;
  }

  const companyId = await resolveLegalEntityId(auth, built.legalEntityId ?? auth.legalEntityId ?? undefined).catch(() => null);
  const company = companyId
    ? await prisma.legalEntity.findUnique({ where: { id: companyId }, select: { legalName: true } })
    : null;
  const teamOnly = !isManagement(auth);
  const subtitle = [built.rangeLabel, ...(await filterLabel(query)), ...(teamOnly ? ['My team'] : [])].join(' · ');

  if (query.format !== 'json' || definition.sensitive) {
    await recordAudit({
      action: query.format === 'json' ? 'VIEW_SENSITIVE' : 'EXPORT',
      entityType: 'Report',
      entityId: type,
      legalEntityId: built.legalEntityId ?? scopedEntityId(auth),
      summary:
        query.format === 'json'
          ? `Viewed the ${definition.title.toLowerCase()} (${built.rows.length} rows): ${subtitle}`
          : `Exported the ${definition.title.toLowerCase()} as ${query.format.toUpperCase()} (${built.rows.length} rows): ${subtitle}`,
      actor: auth,
      ...fingerprint,
    });
  }

  return {
    type,
    teamOnly,
    title: definition.title,
    subtitle,
    columns: built.columns,
    rows: built.rows,
    summary: built.summary,
    generatedAt: now,
    generatedBy: auth.email,
    companyName: company?.legalName ?? 'Pollux HR',
  };
}
