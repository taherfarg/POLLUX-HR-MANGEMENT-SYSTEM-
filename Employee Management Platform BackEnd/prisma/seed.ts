/**
 * Demo data for Pollux HR - POLLUX MOTORS FZE, Dubai.
 *
 * Everything here is fictional. Names, addresses, phone numbers, registration
 * numbers, salaries and email addresses are invented, and the `.demo` domain
 * does not resolve. No real company or personal data is used anywhere.
 *
 * The demo is built around the day the seed runs: attendance covers the
 * previous month and the current month to date, last month's payroll has been
 * run and paid, this month's has been calculated. The shape is deterministic -
 * no randomness - only the dates move with the calendar.
 *
 * Money and time go through the application's own services wherever it
 * matters: attendance is evaluated by the attendance engine, overtime and
 * advances are approved and payroll is calculated, reviewed, approved (by a
 * second person) and paid through the same functions the API calls. The demo
 * therefore shows exactly what the application computes, and the audit trail
 * shows who did what.
 *
 * Run with:  npm run db:seed        (or `npm run db:reset` to rebuild first)
 */
import 'dotenv/config';
import { Prisma } from '@prisma/client';
import type {
  AttendanceRecord,
  ContractType,
  DocumentCategory,
  EmploymentType,
  Gender,
  Role,
  WorkMode,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db/prisma';
import type { AuthContext } from '../src/common/auth-context';
import { evaluateDay, persistableStatus, type DayEvaluation, type DayPlan } from '../src/modules/attendance/attendance.engine';
import { attendancePolicy, freshPlan, loadDayInputs, type DayInputs } from '../src/modules/attendance/attendance.days';
import { approveOvertime, syncOvertimeFromAttendance } from '../src/modules/overtime/overtime.service';
import { approveAdvance, markAdvancePaid, rejectAdvance, requestAdvance } from '../src/modules/advances/advances.service';
import { approveAdjustment, createAdjustment } from '../src/modules/payroll/adjustments.service';
import {
  approvePeriod,
  calculatePeriod,
  createPeriod,
  markPeriodPaid,
  reviewPeriod,
} from '../src/modules/payroll/payroll.service';
import { calculateLeaveDays } from '../src/modules/leave/leave.service';
import { loadWorkContexts, type EmployeeWorkContext } from '../src/services/work-context';
import { addDaysToKey, dayOfWeekForDateKey, zonedDateKey, zonedWallTimeToUtc } from '../src/services/timezone';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Passw0rd!23';
const COMPANY_TZ = 'Asia/Dubai';
const SEED = { ipAddress: null, userAgent: 'pollux-seed' };

// ---------------------------------------------------------------------------
// Dates relative to the day the seed runs
// ---------------------------------------------------------------------------

const NOW = new Date();
const TODAY = zonedDateKey(NOW, COMPANY_TZ);
const YEAR = Number(TODAY.slice(0, 4));
const MONTH = Number(TODAY.slice(5, 7));

const d = (key: string): Date => new Date(`${key}T00:00:00.000Z`);
const pad = (value: number) => String(value).padStart(2, '0');
const monthKey = (year: number, month: number) => `${year}-${pad(month)}`;

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The nth (1-based) given weekday (0 = Sunday) of a month, as YYYY-MM-DD. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return `${year}-${pad(month)}-${pad(Math.min(day, lastDay(year, month)))}`;
}

/** Same day-of-month N months away, clamped to the month's length. */
function monthsFrom(key: string, months: number, dayOffset = 0): string {
  const [y, m, dd] = key.split('-').map(Number) as [number, number, number];
  const target = shiftMonth(y, m, months);
  return addDaysToKey(`${target.year}-${pad(target.month)}-${pad(Math.min(dd, lastDay(target.year, target.month)))}`, dayOffset);
}

const PREV = shiftMonth(YEAR, MONTH, -1);
const NEXT = shiftMonth(YEAR, MONTH, 1);
const PREV_START = `${monthKey(PREV.year, PREV.month)}-01`;

/** Small deterministic hash: the same employee and day always get the same variation. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

const COMPANY = {
  code: 'PLX-AE',
  name: 'Pollux Motors',
  legalName: 'POLLUX MOTORS FZE',
  registrationNumber: 'FZE-DEMO-2019-0417',
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
  city: 'Dubai',
  addressLine: 'Showroom 3, Demo Auto District, Dubai',
  currency: 'AED',
  timezone: COMPANY_TZ,
  workWeek: [1, 2, 3, 4, 5],
  weeklyHours: 40,
  probationMonths: 6,
  noticePeriodDays: 30,
  establishedOn: '2019-04-17',
};

const DEPARTMENTS = [
  { code: 'MGMT', name: 'Management', description: 'General management' },
  { code: 'SALES', name: 'Sales', description: 'New and pre-owned vehicle sales, fleet and leasing' },
  { code: 'SERVICE', name: 'After-Sales & Service', description: 'Workshop, service advisory and parts' },
  { code: 'FIN', name: 'Finance', description: 'Accounting, payroll administration and reporting' },
  { code: 'HR', name: 'HR & Administration', description: 'People, PRO services and office administration' },
  { code: 'MKT', name: 'Marketing', description: 'Brand, digital marketing and events' },
  { code: 'IT', name: 'IT & Digital', description: 'Systems, website and dealer management software' },
] as const;

const LOCATIONS = [
  { code: 'DXB-OFFICE', name: 'Dubai Office', kind: 'OFFICE', addressLine: 'Showroom 3, Demo Auto District', city: 'Dubai', countryCode: 'AE', countryName: 'United Arab Emirates', timezone: 'Asia/Dubai' },
  { code: 'FIELD-UAE', name: 'Field - UAE', kind: 'FIELD', addressLine: null, city: 'Dubai', countryCode: 'AE', countryName: 'United Arab Emirates', timezone: 'Asia/Dubai' },
  { code: 'REMOTE-CAI', name: 'Remote - Cairo', kind: 'REMOTE', addressLine: null, city: 'Cairo', countryCode: 'EG', countryName: 'Egypt', timezone: 'Africa/Cairo' },
  { code: 'REMOTE-ALG', name: 'Remote - Algiers', kind: 'REMOTE', addressLine: null, city: 'Algiers', countryCode: 'DZ', countryName: 'Algeria', timezone: 'Africa/Algiers' },
] as const;

type Day = { dayOfWeek: number; start: number; end: number; breakMinutes: number };
const hours = (clock: string) => {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const week = (days: number[], start: string, end: string, breakMinutes: number): Day[] =>
  days.map((dayOfWeek) => ({ dayOfWeek, start: hours(start), end: hours(end), breakMinutes }));

const SCHEDULES = [
  { code: 'STD-DXB', name: 'Standard Dubai Office', description: 'Monday to Friday, 09:00-18:00 Dubai time, one-hour break', timezone: 'Asia/Dubai', days: week([1, 2, 3, 4, 5], '09:00', '18:00', 60) },
  { code: 'SHOWROOM', name: 'Showroom (Mon-Sat)', description: 'Monday to Saturday, 10:00-19:00 Dubai time, one-hour break', timezone: 'Asia/Dubai', days: week([1, 2, 3, 4, 5, 6], '10:00', '19:00', 60) },
  { code: 'REMOTE-CAI', name: 'Remote - Cairo', description: 'Sunday to Thursday, 09:00-17:00 Cairo time, 30-minute break', timezone: 'Africa/Cairo', days: week([0, 1, 2, 3, 4], '09:00', '17:00', 30) },
  { code: 'REMOTE-ALG', name: 'Remote - Algiers', description: 'Sunday to Thursday, 08:30-16:30 Algiers time, 30-minute break', timezone: 'Africa/Algiers', days: week([0, 1, 2, 3, 4], '08:30', '16:30', 30) },
  { code: 'PART-TIME', name: 'Part-time mornings', description: 'Monday to Friday, 09:00-13:00 Dubai time', timezone: 'Asia/Dubai', days: week([1, 2, 3, 4, 5], '09:00', '13:00', 0) },
] as const;

/**
 * Holidays. Islamic holidays move with lunar observation and are announced
 * close to the date - these are illustrative estimates, not official dates.
 * Fixed-date holidays are entered once and recur every year.
 */
const CALENDARS = [
  {
    code: 'PLX-UAE',
    name: 'Pollux UAE Holiday Calendar',
    countryCode: 'AE',
    description: 'UAE public holidays plus Pollux company days. The default for everyone.',
    holidays: [
      { name: "New Year's Day", date: '2026-01-01', recurring: true },
      { name: 'Eid al-Fitr', date: '2026-03-20' },
      { name: 'Eid al-Fitr Holiday', date: '2026-03-23' },
      { name: 'Pollux Founders Day', date: '2026-04-17', recurring: true, type: 'COMPANY' as const },
      { name: 'Arafat Day', date: '2026-05-26' },
      { name: 'Eid al-Adha', date: '2026-05-27' },
      { name: 'Eid al-Adha Holiday', date: '2026-05-28' },
      { name: 'Islamic New Year', date: '2026-06-16' },
      { name: "Prophet's Birthday", date: '2026-08-25' },
      { name: 'Commemoration Day', date: '2026-12-01', recurring: true },
      { name: 'UAE National Day', date: '2026-12-02', recurring: true },
      { name: 'UAE National Day Holiday', date: '2026-12-03', recurring: true },
      { name: 'Eid al-Fitr', date: '2027-03-10' },
      { name: 'Eid al-Fitr Holiday', date: '2027-03-11' },
      { name: 'Arafat Day', date: '2027-05-15' },
      { name: 'Eid al-Adha', date: '2027-05-16' },
      { name: 'Eid al-Adha Holiday', date: '2027-05-17' },
      { name: 'Islamic New Year', date: '2027-06-06' },
      { name: "Prophet's Birthday", date: '2027-08-15' },
    ],
  },
  {
    code: 'EGY',
    name: 'Egypt Public Holidays',
    countryCode: 'EG',
    description: 'For remote colleagues who follow Egyptian public holidays.',
    holidays: [
      { name: 'Coptic Christmas', date: '2026-01-07', recurring: true },
      { name: 'Revolution Day (25 January)', date: '2026-01-25', recurring: true },
      { name: 'Eid al-Fitr', date: '2026-03-22' },
      { name: 'Sinai Liberation Day', date: '2026-04-25', recurring: true },
      { name: 'Labour Day', date: '2026-05-01', recurring: true },
      { name: 'Eid al-Adha', date: '2026-05-27' },
      { name: 'Eid al-Adha Holiday', date: '2026-05-28' },
      { name: 'June 30 Revolution', date: '2026-06-30', recurring: true },
      { name: 'Revolution Day (23 July)', date: '2026-07-23', recurring: true },
      { name: "Prophet's Birthday", date: '2026-08-26' },
      { name: 'Armed Forces Day', date: '2026-10-06', recurring: true },
    ],
  },
];

const LEAVE_TYPES = [
  { code: 'ANNUAL', name: 'Annual Leave', days: 30, colour: '#2563eb', paid: true, halfDay: true, notice: 7, carryOver: 10 },
  { code: 'SICK', name: 'Sick Leave', days: 15, colour: '#dc2626', paid: true, halfDay: true, notice: 0, carryOver: 0, attachment: true },
  { code: 'UNPAID', name: 'Unpaid Leave', days: 30, colour: '#64748b', paid: false, halfDay: true, notice: 3, carryOver: 0 },
  { code: 'PARENTAL', name: 'Parental Leave', days: 5, colour: '#7c3aed', paid: true, halfDay: false, notice: 0, carryOver: 0 },
  { code: 'MATERNITY', name: 'Maternity Leave', days: 60, colour: '#db2777', paid: true, halfDay: false, notice: 30, carryOver: 0, gender: 'FEMALE' as Gender },
  { code: 'BEREAVEMENT', name: 'Bereavement Leave', days: 5, colour: '#475569', paid: true, halfDay: false, notice: 0, carryOver: 0 },
] as const;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

interface SeedEmployee {
  number: string;
  first: string;
  last: string;
  gender: Gender;
  nationality: string;
  dob: string;
  phone: string;
  job: string;
  department: (typeof DEPARTMENTS)[number]['code'];
  manager: string | null;
  workMode: WorkMode;
  location: (typeof LOCATIONS)[number]['code'];
  schedule: (typeof SCHEDULES)[number]['code'];
  calendar?: string;
  timezone?: string;
  workCountry?: { code: string; name: string; city: string };
  hire: string;
  exit?: { date: string; reason: string };
  employmentType?: EmploymentType;
  contractType?: ContractType;
  contractEnd?: string;
  /** Salary history, oldest first: [from, basic, housing, transport, other, reason]. */
  salary: [string, number, number, number, number, string][];
  login?: { email: string; role: Role };
  attendanceTracked?: boolean;
  overtimeEligible?: boolean;
}

const DANIEL_HIRE = addDaysToKey(monthsFrom(TODAY, -6), 12); // probation ends in 12 days

const EMPLOYEES: SeedEmployee[] = [
  {
    number: 'PLX-0001', first: 'Khalid', last: 'Al Mansoori', gender: 'MALE', nationality: 'Emirati', dob: '1978-11-02', phone: '+971 50 100 0001',
    job: 'General Manager', department: 'MGMT', manager: null, workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2019-04-21', salary: [['2019-04-21', 32000, 8000, 2000, 0, 'Starting compensation']],
    login: { email: 'admin@pollux.demo', role: 'ADMIN' }, attendanceTracked: false, overtimeEligible: false,
  },
  {
    number: 'PLX-0002', first: 'Sara', last: 'Haddad', gender: 'FEMALE', nationality: 'Lebanese', dob: '1986-03-14', phone: '+971 50 100 0002',
    job: 'HR Manager', department: 'HR', manager: 'PLX-0001', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2019-06-02', salary: [['2019-06-02', 16000, 4000, 1000, 0, 'Starting compensation']],
    login: { email: 'hr@pollux.demo', role: 'HR_ADMIN' }, overtimeEligible: false,
  },
  {
    number: 'PLX-0003', first: 'Youssef', last: 'Karim', gender: 'MALE', nationality: 'Egyptian', dob: '1984-07-22', phone: '+971 50 100 0003',
    job: 'Sales Manager', department: 'SALES', manager: 'PLX-0001', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2020-01-12',
    salary: [
      ['2020-01-12', 15000, 4000, 1500, 0, 'Starting compensation as Senior Sales Executive'],
      ['2024-01-01', 18000, 4500, 1500, 0, 'Promotion to Sales Manager'],
    ],
    login: { email: 'manager@pollux.demo', role: 'MANAGER' }, overtimeEligible: false,
  },
  {
    number: 'PLX-0004', first: 'Ahmed', last: 'Nabil', gender: 'MALE', nationality: 'Egyptian', dob: '1994-01-09', phone: '+971 50 100 0004',
    job: 'Sales Executive', department: 'SALES', manager: 'PLX-0003', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2023-02-05',
    salary: [
      ['2023-02-05', 4500, 500, 500, 0, 'Starting compensation'],
      ['2025-02-01', 5000, 500, 500, 0, 'Annual increment'],
    ],
    login: { email: 'employee@pollux.demo', role: 'EMPLOYEE' },
  },
  {
    number: 'PLX-0005', first: 'Layla', last: 'Mansour', gender: 'FEMALE', nationality: 'Jordanian', dob: '1991-05-30', phone: '+971 50 100 0005',
    job: 'Senior Sales Executive', department: 'SALES', manager: 'PLX-0003', workMode: 'FIELD', location: 'FIELD-UAE', schedule: 'SHOWROOM',
    hire: '2022-03-13', salary: [['2022-03-13', 6000, 1000, 800, 0, 'Starting compensation']],
    login: { email: 'layla.mansour@pollux.demo', role: 'EMPLOYEE' },
  },
  {
    number: 'PLX-0006', first: 'Daniel', last: 'Mathew', gender: 'MALE', nationality: 'Indian', dob: '1997-09-18', phone: '+971 50 100 0006',
    job: 'Sales Executive', department: 'SALES', manager: 'PLX-0003', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'SHOWROOM',
    hire: DANIEL_HIRE, salary: [[DANIEL_HIRE, 5500, 800, 500, 0, 'Starting compensation']],
  },
  {
    number: 'PLX-0007', first: 'Hassan', last: 'Qureshi', gender: 'MALE', nationality: 'Pakistani', dob: '1982-12-05', phone: '+971 50 100 0007',
    job: 'After-Sales Manager', department: 'SERVICE', manager: 'PLX-0001', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2020-05-17', salary: [['2020-05-17', 14000, 3500, 1000, 0, 'Starting compensation']], overtimeEligible: false,
  },
  {
    number: 'PLX-0008', first: 'Omar', last: 'Farouk', gender: 'MALE', nationality: 'Syrian', dob: '1990-02-27', phone: '+971 50 100 0008',
    job: 'Service Advisor', department: 'SERVICE', manager: 'PLX-0007', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'SHOWROOM',
    hire: '2021-09-01', salary: [['2021-09-01', 7000, 1500, 500, 0, 'Starting compensation']],
  },
  {
    number: 'PLX-0009', first: 'Priya', last: 'Nair', gender: 'FEMALE', nationality: 'Indian', dob: '1988-08-11', phone: '+971 50 100 0009',
    job: 'Finance Manager', department: 'FIN', manager: 'PLX-0001', workMode: 'HYBRID', location: 'DXB-OFFICE', schedule: 'STD-DXB',
    hire: '2021-07-04', salary: [['2021-07-04', 12000, 3000, 1000, 0, 'Starting compensation']], overtimeEligible: false,
  },
  {
    number: 'PLX-0010', first: 'Rashid', last: 'Al Suwaidi', gender: 'MALE', nationality: 'Emirati', dob: '1989-04-03', phone: '+971 50 100 0010',
    job: 'PRO & Government Relations Officer', department: 'HR', manager: 'PLX-0002', workMode: 'FIELD', location: 'FIELD-UAE', schedule: 'STD-DXB',
    hire: '2021-02-14', salary: [['2021-02-14', 8500, 2000, 1500, 0, 'Starting compensation']],
  },
  {
    number: 'PLX-0011', first: 'Grace', last: 'Okafor', gender: 'FEMALE', nationality: 'Nigerian', dob: '1999-06-21', phone: '+971 50 100 0011',
    job: 'Receptionist', department: 'HR', manager: 'PLX-0002', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'PART-TIME',
    hire: '2025-08-18', employmentType: 'PART_TIME', contractType: 'LIMITED', contractEnd: addDaysToKey(TODAY, 55),
    salary: [['2025-08-18', 3000, 0, 300, 0, 'Starting compensation (part-time)']],
  },
  {
    number: 'PLX-0012', first: 'Nour', last: 'El-Sayed', gender: 'FEMALE', nationality: 'Egyptian', dob: '1995-10-12', phone: '+20 100 000 0012',
    job: 'Digital Marketing Specialist', department: 'MKT', manager: 'PLX-0001', workMode: 'REMOTE', location: 'REMOTE-CAI', schedule: 'REMOTE-CAI',
    // A remote colleague who follows Egyptian public holidays.
    calendar: 'EGY', timezone: 'Africa/Cairo', workCountry: { code: 'EG', name: 'Egypt', city: 'Cairo' },
    hire: '2024-01-14', salary: [['2024-01-14', 7000, 0, 0, 500, 'Starting compensation (remote, internet allowance)']],
    login: { email: 'nour.elsayed@pollux.demo', role: 'EMPLOYEE' },
  },
  {
    number: 'PLX-0013', first: 'Amine', last: 'Benali', gender: 'MALE', nationality: 'Algerian', dob: '1993-03-08', phone: '+213 550 000 013',
    job: 'Software Developer', department: 'IT', manager: 'PLX-0001', workMode: 'REMOTE', location: 'REMOTE-ALG', schedule: 'REMOTE-ALG',
    // Lives in Algiers but follows the Pollux UAE calendar - the calendar is
    // assigned, never assumed from the country.
    calendar: 'PLX-UAE', timezone: 'Africa/Algiers', workCountry: { code: 'DZ', name: 'Algeria', city: 'Algiers' },
    hire: '2025-02-02', salary: [['2025-02-02', 8000, 0, 0, 500, 'Starting compensation (remote, internet allowance)']],
    login: { email: 'amine.benali@pollux.demo', role: 'EMPLOYEE' },
  },
  {
    number: 'PLX-0014', first: 'Victor', last: 'Silva', gender: 'MALE', nationality: 'Brazilian', dob: '1992-11-19', phone: '+971 50 100 0014',
    job: 'Sales Executive', department: 'SALES', manager: 'PLX-0003', workMode: 'ONSITE', location: 'DXB-OFFICE', schedule: 'SHOWROOM',
    hire: '2022-05-01', exit: { date: monthsFrom(PREV_START, -3, -1), reason: 'Resigned - relocated abroad' },
    salary: [['2022-05-01', 5200, 800, 500, 0, 'Starting compensation']],
  },
];

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

async function reset(): Promise<void> {
  await prisma.$transaction([
    prisma.overtimeEntry.deleteMany(),
    prisma.salaryAdvanceInstallment.deleteMany(),
    prisma.payrollAdjustment.deleteMany(),
    prisma.payrollItem.deleteMany(),
    prisma.payrollRecord.deleteMany(),
    prisma.payrollPeriod.deleteMany(),
    prisma.salaryAdvance.deleteMany(),
    prisma.attendanceRecord.deleteMany(),
    prisma.documentFile.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.leaveRequestDetail.deleteMany(),
    prisma.documentRequestDetail.deleteMany(),
    prisma.profileChangeRequestDetail.deleteMany(),
    prisma.request.deleteMany(),
    prisma.leaveBalance.deleteMany(),
    prisma.document.deleteMany(),
    prisma.employmentEvent.deleteMany(),
    prisma.compensationRecord.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
    prisma.holiday.deleteMany(),
    prisma.leaveType.deleteMany(),
  ]);
  // Self-references first, then the rows they point at.
  await prisma.department.updateMany({ data: { headId: null } });
  await prisma.employee.updateMany({ data: { managerId: null } });
  await prisma.employee.deleteMany();
  await prisma.department.deleteMany();
  await prisma.companySettings.deleteMany();
  await prisma.workScheduleDay.deleteMany();
  await prisma.workSchedule.deleteMany();
  await prisma.workLocation.deleteMany();
  await prisma.holidayCalendar.deleteMany();
  await prisma.legalEntity.deleteMany();
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

function recordData(plan: DayPlan, evaluation: DayEvaluation) {
  return {
    dayType: plan.dayType,
    scheduleId: plan.scheduleId,
    scheduledStart: plan.scheduledStart,
    scheduledEnd: plan.scheduledEnd,
    scheduledMinutes: plan.scheduledMinutes,
    breakMinutes: evaluation.breakMinutes,
    workedMinutes: evaluation.workedMinutes,
    lateMinutes: evaluation.lateMinutes,
    earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
    overtimeMinutes: evaluation.overtimeMinutes,
    absentDays: new Prisma.Decimal(evaluation.absentDays),
    status: persistableStatus(evaluation.status),
  };
}

interface DayScript {
  /** No record at all: an absence on a working day. */
  absent?: boolean;
  /** Minutes after the scheduled start. */
  inOffset?: number;
  /** Minutes after the scheduled end. */
  outOffset?: number;
  /** Checked in, never checked out. */
  open?: boolean;
}

async function writeDay(
  context: EmployeeWorkContext,
  inputs: DayInputs,
  dateKey: string,
  script: DayScript,
): Promise<AttendanceRecord | null> {
  const plan = freshPlan(context, inputs, dateKey);
  if (!plan.isEmployed || plan.dayType !== 'WORKING_DAY' || script.absent) return null;
  if (!plan.scheduledStart || !plan.scheduledEnd) return null;

  const day = context.schedule.days[plan.dayOfWeek];
  if (!day || day.startMinute === null || day.endMinute === null) return null;

  const checkIn = zonedWallTimeToUtc(dateKey, day.startMinute + (script.inOffset ?? 0), plan.timezone);
  if (checkIn > NOW) return null;
  const plannedOut = zonedWallTimeToUtc(dateKey, day.endMinute + (script.outOffset ?? 0), plan.timezone);
  const checkOut = script.open || plannedOut > NOW ? null : plannedOut;

  const todayKey = zonedDateKey(NOW, plan.timezone);
  const evaluation = evaluateDay(plan, { checkIn, checkOut, statusOverride: null }, attendancePolicy(context.settings), {
    overtimeEligible: context.overtimeEligible,
    attendanceTracked: context.attendanceTracked,
    now: NOW,
    todayKey,
  });

  const source = hash(`${context.employeeNumber}${dateKey}src`) % 3 === 0 ? 'MOBILE' : 'WEB';
  return prisma.$transaction(async (tx) => {
    const record = await tx.attendanceRecord.create({
      data: {
        employeeId: context.employeeId,
        legalEntityId: context.legalEntityId,
        workDate: d(dateKey),
        timezone: plan.timezone,
        checkIn,
        checkOut,
        checkInSource: source,
        checkOutSource: checkOut ? source : null,
        source,
        ...recordData(plan, evaluation),
      },
    });
    await syncOvertimeFromAttendance(tx, { record, settings: context.settings });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Seeding Pollux HR demo data for ${TODAY} (Dubai)...`);
  await reset();

  // --- Company, departments, locations, schedules, calendars -----------------
  const entity = await prisma.legalEntity.create({
    data: {
      ...COMPANY,
      weeklyHours: new Prisma.Decimal(COMPANY.weeklyHours),
      establishedOn: d(COMPANY.establishedOn),
    },
  });

  const departmentIds = new Map<string, string>();
  for (const department of DEPARTMENTS) {
    const created = await prisma.department.create({ data: department });
    departmentIds.set(department.code, created.id);
  }

  const locationIds = new Map<string, string>();
  for (const location of LOCATIONS) {
    const created = await prisma.workLocation.create({ data: { ...location, legalEntityId: entity.id } });
    locationIds.set(location.code, created.id);
  }

  const scheduleIds = new Map<string, string>();
  for (const schedule of SCHEDULES) {
    const created = await prisma.workSchedule.create({
      data: {
        legalEntityId: entity.id,
        code: schedule.code,
        name: schedule.name,
        description: schedule.description,
        timezone: schedule.timezone,
        days: {
          create: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
            const day = schedule.days.find((candidate) => candidate.dayOfWeek === dayOfWeek);
            return day
              ? { dayOfWeek, isWorkingDay: true, startMinute: day.start, endMinute: day.end, breakMinutes: day.breakMinutes }
              : { dayOfWeek, isWorkingDay: false, startMinute: null, endMinute: null, breakMinutes: 0 };
          }),
        },
      },
    });
    scheduleIds.set(schedule.code, created.id);
  }

  const calendarIds = new Map<string, string>();
  let holidayCount = 0;
  for (const calendar of CALENDARS) {
    const created = await prisma.holidayCalendar.create({
      data: {
        legalEntityId: entity.id,
        code: calendar.code,
        name: calendar.name,
        countryCode: calendar.countryCode,
        description: calendar.description,
      },
    });
    calendarIds.set(calendar.code, created.id);
    for (const holiday of calendar.holidays) {
      await prisma.holiday.create({
        data: {
          legalEntityId: entity.id,
          calendarId: created.id,
          name: holiday.name,
          date: d(holiday.date),
          type: 'type' in holiday ? holiday.type : 'PUBLIC',
          isRecurringAnnually: 'recurring' in holiday ? Boolean(holiday.recurring) : false,
        },
      });
      holidayCount += 1;
    }
  }

  const settings = await prisma.companySettings.create({
    data: {
      legalEntityId: entity.id,
      isPrimary: true,
      displayName: 'Pollux Motors',
      employeeNumberPrefix: 'PLX',
      defaultWorkScheduleId: scheduleIds.get('STD-DXB') as string,
      defaultHolidayCalendarId: calendarIds.get('PLX-UAE') as string,
      // Tracking "started" at the beginning of last month, so the demo has a
      // full month of history and nothing earlier counts as an absence.
      attendanceStartDate: d(PREV_START),
      lateGraceMinutes: 10,
      earlyLeaveGraceMinutes: 10,
      minOvertimeMinutes: 30,
      overtimeRequiresApproval: true,
      overtimeRateMultiplier: new Prisma.Decimal('1.25'),
      restDayOvertimeMultiplier: new Prisma.Decimal('1.50'),
      payrollDay: 28,
      salaryDayBasis: 'FIXED_30',
      absenceDeductionEnabled: true,
      unpaidLeaveDeductionEnabled: true,
      lateDeductionEnabled: false,
      payrollRequiresSeparateApprover: true,
      maxAdvanceAmount: new Prisma.Decimal(10000),
      maxAdvanceInstallments: 12,
    },
  });
  console.log(`  company ${COMPANY.legalName}, ${DEPARTMENTS.length} departments, ${LOCATIONS.length} work locations, ${SCHEDULES.length} schedules, ${holidayCount} holidays`);

  // --- Leave types ------------------------------------------------------------
  const leaveTypeIds = new Map<string, string>();
  for (const type of LEAVE_TYPES) {
    const created = await prisma.leaveType.create({
      data: {
        legalEntityId: entity.id,
        code: type.code,
        name: type.name,
        colorHex: type.colour,
        annualEntitlementDays: new Prisma.Decimal(type.days),
        isPaid: type.paid,
        requiresAttachment: 'attachment' in type ? type.attachment : false,
        allowsHalfDay: type.halfDay,
        minNoticeDays: type.notice,
        carryOverMaxDays: new Prisma.Decimal(type.carryOver),
        restrictedToGender: 'gender' in type ? type.gender : null,
      },
    });
    leaveTypeIds.set(type.code, created.id);
  }

  // --- Employees, logins, salary history, timeline -----------------------------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const employeeIds = new Map<string, string>();
  const auth = new Map<string, AuthContext>();

  for (const person of EMPLOYEES) {
    const probationEnd = monthsFrom(person.hire, COMPANY.probationMonths);
    const status = person.exit ? 'OFFBOARDED' : probationEnd > TODAY ? 'PROBATION' : 'ACTIVE';
    const created = await prisma.employee.create({
      data: {
        employeeNumber: person.number,
        firstName: person.first,
        lastName: person.last,
        workEmail: person.login?.email ?? `${person.first}.${person.last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@pollux.demo',
        personalEmail: `${person.first}.${person.last.charAt(0)}@mail.demo`.toLowerCase().replace(/[^a-z.@]/g, ''),
        phone: person.phone,
        dateOfBirth: d(person.dob),
        gender: person.gender,
        nationality: person.nationality,
        city: person.workCountry?.city ?? 'Dubai',
        country: person.workCountry?.name ?? 'United Arab Emirates',
        emergencyContactName: 'Family contact (demo)',
        emergencyContactPhone: '+971 50 999 0000',
        emergencyContactRelation: 'Family',
        legalEntityId: entity.id,
        departmentId: departmentIds.get(person.department) as string,
        jobTitle: person.job,
        employmentType: person.employmentType ?? 'FULL_TIME',
        contractType: person.contractType ?? 'UNLIMITED',
        contractEndDate: person.contractEnd ? d(person.contractEnd) : null,
        workMode: person.workMode,
        status,
        hireDate: d(person.hire),
        probationEndDate: d(probationEnd),
        exitDate: person.exit ? d(person.exit.date) : null,
        exitReason: person.exit?.reason ?? null,
        noticePeriodDays: COMPANY.noticePeriodDays,
        workLocationId: locationIds.get(person.location) as string,
        workScheduleId: scheduleIds.get(person.schedule) as string,
        holidayCalendarId: person.calendar ? (calendarIds.get(person.calendar) as string) : null,
        timezone: person.timezone ?? null,
        workCountryCode: person.workCountry?.code ?? null,
        workCountry: person.workCountry?.name ?? null,
        workCity: person.workCountry?.city ?? null,
        attendanceTracked: person.attendanceTracked ?? true,
        overtimeEligible: person.overtimeEligible ?? true,
      },
    });
    employeeIds.set(person.number, created.id);

    for (const [index, [from, basic, housing, transport, other, reason]] of person.salary.entries()) {
      const next = person.salary[index + 1];
      await prisma.compensationRecord.create({
        data: {
          employeeId: created.id,
          effectiveFrom: d(from),
          effectiveTo: next ? d(addDaysToKey(next[0], -1)) : person.exit ? d(person.exit.date) : null,
          baseSalary: new Prisma.Decimal(basic),
          housingAllowance: new Prisma.Decimal(housing),
          transportAllowance: new Prisma.Decimal(transport),
          otherAllowances: new Prisma.Decimal(other),
          currency: 'AED',
          changeReason: reason,
          isCurrent: !next,
        },
      });
    }

    await prisma.employmentEvent.create({
      data: { employeeId: created.id, type: 'HIRED', effectiveDate: d(person.hire), title: `Joined as ${person.job}` },
    });
    if (status === 'ACTIVE' && !person.exit) {
      await prisma.employmentEvent.create({
        data: { employeeId: created.id, type: 'PROBATION_COMPLETED', effectiveDate: d(probationEnd), title: 'Probation completed' },
      });
    }
    if (person.exit) {
      await prisma.employmentEvent.create({
        data: { employeeId: created.id, type: 'OFFBOARDED', effectiveDate: d(person.exit.date), title: 'Left the company', description: person.exit.reason },
      });
    }

    if (person.login) {
      const user = await prisma.user.create({
        data: { email: person.login.email, passwordHash, role: person.login.role, employeeId: created.id },
      });
      auth.set(person.number, {
        userId: user.id,
        email: user.email,
        role: user.role,
        employeeId: created.id,
        legalEntityId: entity.id,
        scopedLegalEntityId: null,
      });
    }
  }

  // Salary changes and promotions on the timeline, then managers and heads.
  await prisma.$transaction(async (tx) => {
    for (const person of EMPLOYEES) {
      const id = employeeIds.get(person.number) as string;
      if (person.manager) await tx.employee.update({ where: { id }, data: { managerId: employeeIds.get(person.manager) as string } });
      for (const [from, basic, , , , reason] of person.salary.slice(1)) {
        await tx.employmentEvent.create({
          data: {
            employeeId: id,
            type: reason.startsWith('Promotion') ? 'PROMOTION' : 'COMPENSATION_CHANGE',
            effectiveDate: d(from),
            title: reason,
            newValue: { baseSalary: basic, currency: 'AED' },
          },
        });
      }
    }
    const heads: [string, string][] = [['MGMT', 'PLX-0001'], ['SALES', 'PLX-0003'], ['SERVICE', 'PLX-0007'], ['FIN', 'PLX-0009'], ['HR', 'PLX-0002']];
    for (const [department, head] of heads) {
      await tx.department.update({ where: { id: departmentIds.get(department) as string }, data: { headId: employeeIds.get(head) as string } });
    }
  });
  const compensationCount = await prisma.compensationRecord.count();
  console.log(`  ${EMPLOYEES.length} employees, ${auth.size} logins, ${compensationCount} salary records`);

  const hr = auth.get('PLX-0002') as AuthContext;
  const admin = auth.get('PLX-0001') as AuthContext;
  const manager = auth.get('PLX-0003') as AuthContext;
  const ahmed = auth.get('PLX-0004') as AuthContext;
  const layla = auth.get('PLX-0005') as AuthContext;
  const id = (number: string) => employeeIds.get(number) as string;

  // --- Documents ------------------------------------------------------------------
  const DOCUMENTS: { employee: string; category: DocumentCategory; title: string; issued: string; expires?: string; confidential?: boolean }[] = [
    { employee: 'PLX-0004', category: 'CONTRACT', title: 'Employment Contract', issued: '2023-02-05', confidential: true },
    { employee: 'PLX-0004', category: 'VISA_PERMIT', title: 'UAE Residence Visa', issued: monthsFrom(TODAY, -24, 40), expires: addDaysToKey(TODAY, 40) },
    { employee: 'PLX-0004', category: 'IDENTIFICATION', title: 'Emirates ID', issued: monthsFrom(TODAY, -24, 40), expires: addDaysToKey(TODAY, 40), confidential: true },
    { employee: 'PLX-0005', category: 'CERTIFICATE', title: 'UAE Driving Licence', issued: '2022-02-01', expires: addDaysToKey(TODAY, 18) },
    { employee: 'PLX-0008', category: 'VISA_PERMIT', title: 'UAE Residence Visa', issued: monthsFrom(TODAY, -24, 75), expires: addDaysToKey(TODAY, 75) },
    { employee: 'PLX-0006', category: 'VISA_PERMIT', title: 'UAE Work Permit', issued: DANIEL_HIRE, expires: monthsFrom(DANIEL_HIRE, 24) },
    { employee: 'PLX-0011', category: 'CONTRACT', title: 'Fixed-term Employment Contract (part-time)', issued: '2025-08-18', expires: addDaysToKey(TODAY, 55), confidential: true },
    { employee: 'PLX-0012', category: 'CONTRACT', title: 'Remote Work Agreement', issued: '2024-01-14', confidential: true },
    { employee: 'PLX-0013', category: 'CONTRACT', title: 'Remote Work Agreement', issued: '2025-02-02', confidential: true },
    { employee: 'PLX-0010', category: 'CERTIFICATE', title: 'PRO Services Card', issued: '2025-01-10', expires: '2027-01-09' },
    { employee: 'PLX-0009', category: 'CERTIFICATE', title: 'ACCA Membership Certificate', issued: '2016-09-30' },
  ];
  for (const document of DOCUMENTS) {
    const slug = document.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    await prisma.document.create({
      data: {
        employeeId: id(document.employee),
        category: document.category,
        title: document.title,
        fileName: `${document.employee}-${slug}.pdf`,
        fileUrl: `https://files.pollux.demo/${document.employee}/${slug}.pdf`,
        issuedOn: d(document.issued),
        expiresOn: document.expires ? d(document.expires) : null,
        isConfidential: document.confidential ?? false,
      },
    });
  }

  // --- Leave: balances and requests ------------------------------------------------
  const balanceIds = new Map<string, string>();
  for (const person of EMPLOYEES) {
    if (person.exit) continue;
    const hireYear = Number(person.hire.slice(0, 4));
    const monthsRemaining = hireYear === YEAR ? 12 - (Number(person.hire.slice(5, 7)) - 1) : 12;
    for (const type of LEAVE_TYPES) {
      if ('gender' in type && type.gender !== person.gender) continue;
      const entitled = Math.round(((type.days * monthsRemaining) / 12) * 2) / 2;
      const balance = await prisma.leaveBalance.create({
        data: {
          employeeId: id(person.number),
          leaveTypeId: leaveTypeIds.get(type.code) as string,
          year: YEAR,
          entitledDays: new Prisma.Decimal(entitled),
          // Ahmed carried two days over from last year - the example in the brief.
          carriedOverDays: new Prisma.Decimal(person.number === 'PLX-0004' && type.code === 'ANNUAL' ? 2 : 0),
        },
      });
      balanceIds.set(`${person.number}:${type.code}`, balance.id);
    }
  }

  // Ahmed's unpaid day: the third Thursday of last month, or the next working day.
  let prevUnpaidDay = nthWeekday(PREV.year, PREV.month, 4, 3);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const { workingDays } = await calculateLeaveDays({ legalEntityId: entity.id, employeeId: id('PLX-0004'), startDate: d(prevUnpaidDay), endDate: d(prevUnpaidDay) });
    if (workingDays > 0) break;
    prevUnpaidDay = addDaysToKey(prevUnpaidDay, 1);
  }
  const LEAVE_REQUESTS: {
    employee: string;
    code: (typeof LEAVE_TYPES)[number]['code'];
    start: string;
    end: string;
    status: 'APPROVED' | 'PENDING' | 'REJECTED';
    reason: string;
    decidedBy?: string;
    note?: string;
  }[] = [
    // Ahmed: 10 days used, 3 pending -> 30 + 2 - 10 - 3 = 19 available.
    { employee: 'PLX-0004', code: 'ANNUAL', start: nthWeekday(YEAR, 2, 1, 2), end: addDaysToKey(nthWeekday(YEAR, 2, 1, 2), 4), status: 'APPROVED', reason: 'Family visit', decidedBy: 'PLX-0003', note: 'Approved - enjoy.' },
    { employee: 'PLX-0004', code: 'ANNUAL', start: nthWeekday(YEAR, 5, 1, 1), end: addDaysToKey(nthWeekday(YEAR, 5, 1, 1), 4), status: 'APPROVED', reason: 'Summer break', decidedBy: 'PLX-0003' },
    { employee: 'PLX-0004', code: 'ANNUAL', start: nthWeekday(NEXT.year, NEXT.month, 1, 2), end: addDaysToKey(nthWeekday(NEXT.year, NEXT.month, 1, 2), 2), status: 'PENDING', reason: 'Personal errands' },
    { employee: 'PLX-0004', code: 'UNPAID', start: prevUnpaidDay, end: prevUnpaidDay, status: 'APPROVED', reason: 'Extra day for a family matter', decidedBy: 'PLX-0002', note: 'Approved as unpaid - no annual leave left for that week.' },
    { employee: 'PLX-0005', code: 'ANNUAL', start: nthWeekday(NEXT.year, NEXT.month, 1, 3), end: addDaysToKey(nthWeekday(NEXT.year, NEXT.month, 1, 3), 4), status: 'PENDING', reason: 'Travelling home' },
    { employee: 'PLX-0012', code: 'ANNUAL', start: nthWeekday(PREV.year, PREV.month, 0, 2), end: addDaysToKey(nthWeekday(PREV.year, PREV.month, 0, 2), 1), status: 'APPROVED', reason: 'Short break', decidedBy: 'PLX-0001' },
    { employee: 'PLX-0009', code: 'ANNUAL', start: addDaysToKey(TODAY, -1), end: addDaysToKey(TODAY, 5), status: 'APPROVED', reason: 'Annual trip', decidedBy: 'PLX-0001', note: 'Enjoy - Sara covers approvals.' },
    { employee: 'PLX-0006', code: 'ANNUAL', start: addDaysToKey(TODAY, 20), end: addDaysToKey(TODAY, 24), status: 'REJECTED', reason: 'Holiday', decidedBy: 'PLX-0003', note: 'Please plan leave after your probation review.' },
  ];

  // Omar was off sick for two days earlier this month.
  const sickStart = nthWeekday(YEAR, MONTH, 2, 1);
  if (sickStart < TODAY) {
    LEAVE_REQUESTS.push({ employee: 'PLX-0008', code: 'SICK', start: sickStart, end: addDaysToKey(sickStart, 1), status: 'APPROVED', reason: 'Flu', decidedBy: 'PLX-0002', note: 'Get well soon.' });
  }

  let leaveSequence = 0;
  for (const request of LEAVE_REQUESTS) {
    const { workingDays } = await calculateLeaveDays({
      legalEntityId: entity.id,
      employeeId: id(request.employee),
      startDate: d(request.start),
      endDate: d(request.end),
    });
    if (workingDays <= 0) continue;
    leaveSequence += 1;
    const submitted = addDaysToKey(request.start < TODAY ? request.start : TODAY, request.start < TODAY ? -12 : -2);
    const decider = request.decidedBy ? auth.get(request.decidedBy) : undefined;
    await prisma.request.create({
      data: {
        reference: `LV-${submitted.slice(0, 4)}-${String(leaveSequence).padStart(4, '0')}`,
        type: 'LEAVE',
        status: request.status,
        employeeId: id(request.employee),
        legalEntityId: entity.id,
        submittedAt: d(submitted),
        decidedAt: request.status === 'PENDING' ? null : d(addDaysToKey(submitted, 1)),
        decidedById: request.status === 'PENDING' ? null : (decider?.userId ?? hr.userId),
        decisionNote: request.note ?? null,
        leaveDetail: {
          create: {
            leaveTypeId: leaveTypeIds.get(request.code) as string,
            startDate: d(request.start),
            endDate: d(request.end),
            workingDays: new Prisma.Decimal(workingDays),
            reason: request.reason,
          },
        },
      },
    });
    const balanceId = balanceIds.get(`${request.employee}:${request.code}`);
    if (balanceId && request.status !== 'REJECTED') {
      await prisma.leaveBalance.update({
        where: { id: balanceId },
        data: request.status === 'APPROVED' ? { usedDays: { increment: workingDays } } : { pendingDays: { increment: workingDays } },
      });
    }
  }
  console.log(`  ${leaveSequence} leave requests`);

  // Other requests waiting for HR.
  await prisma.request.create({
    data: {
      reference: `DOC-${YEAR}-0001`,
      type: 'DOCUMENT',
      employeeId: id('PLX-0011'),
      legalEntityId: entity.id,
      submittedAt: d(addDaysToKey(TODAY, -2)),
      documentDetail: {
        create: { documentType: 'SALARY_CERTIFICATE', purpose: 'Opening a bank account', addressedTo: 'Demo National Bank', includeSalary: true },
      },
    },
  });
  await prisma.request.create({
    data: {
      reference: `PRC-${YEAR}-0001`,
      type: 'PROFILE_CHANGE',
      employeeId: id('PLX-0008'),
      legalEntityId: entity.id,
      submittedAt: d(addDaysToKey(TODAY, -1)),
      profileChangeDetail: {
        create: { changes: [{ field: 'phone', label: 'Phone', currentValue: '+971 50 100 0008', proposedValue: '+971 55 200 0008' }] },
      },
    },
  });

  // --- Attendance -------------------------------------------------------------------
  const tracked = EMPLOYEES.filter((person) => !person.exit && person.attendanceTracked !== false);
  const contexts = await loadWorkContexts(tracked.map((person) => id(person.number)));
  const inputs = await loadDayInputs([...contexts.values()], PREV_START, addDaysToKey(TODAY, 1));

  // Ahmed's month: two long days of overtime (4.8 h each) and one unpaid day.
  const ahmedContext = contexts.get(id('PLX-0004')) as EmployeeWorkContext;
  const ahmedInputs = inputs.get(id('PLX-0004')) as DayInputs;
  const isWorkingDay = (context: EmployeeWorkContext, dayInputs: DayInputs, key: string) =>
    freshPlan(context, dayInputs, key).dayType === 'WORKING_DAY';
  const nextWorkingDay = (context: EmployeeWorkContext, dayInputs: DayInputs, key: string, exclude: string[] = []) => {
    let cursor = key;
    while (!isWorkingDay(context, dayInputs, cursor) || exclude.includes(cursor)) cursor = addDaysToKey(cursor, 1);
    return cursor;
  };
  const ahmedOvertime1 = nextWorkingDay(ahmedContext, ahmedInputs, nthWeekday(PREV.year, PREV.month, 2, 2));
  const ahmedOvertime2 = nextWorkingDay(ahmedContext, ahmedInputs, nthWeekday(PREV.year, PREV.month, 2, 4), [ahmedOvertime1]);

  const laylaContext = contexts.get(id('PLX-0005')) as EmployeeWorkContext;
  const laylaInputs = inputs.get(id('PLX-0005')) as DayInputs;
  const laylaAbsent = nextWorkingDay(laylaContext, laylaInputs, nthWeekday(PREV.year, PREV.month, 3, 2));
  const firstOfMonth = `${monthKey(YEAR, MONTH)}-01`;
  const laylaOvertimeThisMonth = nextWorkingDay(laylaContext, laylaInputs, firstOfMonth);

  const omarContext = contexts.get(id('PLX-0008')) as EmployeeWorkContext;
  const omarInputs = inputs.get(id('PLX-0008')) as DayInputs;
  const omarAbsent = nextWorkingDay(omarContext, omarInputs, nthWeekday(YEAR, MONTH, 1, 3));

  let recordCount = 0;
  const overtimeToApprove: string[] = [];
  for (const person of tracked) {
    const context = contexts.get(id(person.number)) as EmployeeWorkContext;
    const dayInputs = inputs.get(id(person.number)) as DayInputs;
    const localToday = zonedDateKey(NOW, context.timezone);
    // The last working day before today, for Daniel's forgotten check-out.
    let lastWorkingDay = addDaysToKey(localToday, -1);
    while (lastWorkingDay >= PREV_START && !isWorkingDay(context, dayInputs, lastWorkingDay)) lastWorkingDay = addDaysToKey(lastWorkingDay, -1);

    for (let key = PREV_START; key <= localToday; key = addDaysToKey(key, 1)) {
      const variation = hash(`${person.number}:${key}`);
      const script: DayScript = {
        // Mostly on time or a few minutes early; about one day in twelve late.
        inOffset: variation % 12 === 0 ? 12 + (variation % 24) : (variation % 16) - 12,
        outOffset: variation % 21,
      };

      if (person.number === 'PLX-0004') {
        if (key === ahmedOvertime1 || key === ahmedOvertime2) Object.assign(script, { inOffset: -2, outOffset: 288 });
        else if (key < firstOfMonth) script.inOffset = Math.min(script.inOffset ?? 0, 5); // on time all of last month
      }
      if (person.number === 'PLX-0005') {
        if (key === laylaAbsent) script.absent = true;
        if (key === laylaOvertimeThisMonth && key < localToday) script.outOffset = 120;
        if (key === localToday) script.inOffset = 22; // late today
      }
      if (person.number === 'PLX-0008' && (key === omarAbsent || key === localToday)) script.absent = true;
      if (person.number === 'PLX-0006' && key === lastWorkingDay) script.open = true; // forgot to check out

      const record = await writeDay(context, dayInputs, key, script);
      if (!record) continue;
      recordCount += 1;
      if (person.number === 'PLX-0004' && (key === ahmedOvertime1 || key === ahmedOvertime2)) overtimeToApprove.push(record.id);
    }
  }
  const overtimeCount = await prisma.overtimeEntry.count();
  console.log(`  ${recordCount} attendance records, ${overtimeCount} overtime entries`);

  // The manager approves Ahmed's overtime; Layla's from this month waits for a decision.
  for (const attendanceId of overtimeToApprove) {
    const entry = await prisma.overtimeEntry.findUnique({ where: { attendanceId }, select: { id: true } });
    if (entry) await approveOvertime(manager, entry.id, 'Stayed for the fleet handover - approved.', SEED);
  }

  // --- Salary advances ---------------------------------------------------------------
  // Omar: an advance repaid in full before Pollux HR was introduced. Created
  // first so the references run in order.
  const omarStart = shiftMonth(YEAR, MONTH, -6);
  await prisma.salaryAdvance.create({
    data: {
      reference: `ADV-${omarStart.year}-0001`,
      employeeId: id('PLX-0008'),
      legalEntityId: entity.id,
      currency: 'AED',
      requestedAmount: new Prisma.Decimal(1500),
      approvedAmount: new Prisma.Decimal(1500),
      requestedInstallments: 3,
      numberOfInstallments: 3,
      installmentAmount: new Prisma.Decimal(500),
      remainingAmount: new Prisma.Decimal(0),
      reason: 'Medical bills',
      status: 'COMPLETED',
      requestDate: d(`${monthKey(omarStart.year, omarStart.month)}-05`),
      repaymentStartDate: d(`${monthKey(omarStart.year, omarStart.month)}-01`),
      approvedById: hr.userId,
      approvedAt: d(`${monthKey(omarStart.year, omarStart.month)}-06`),
      paidAt: d(`${monthKey(omarStart.year, omarStart.month)}-08`),
      completedAt: d(`${monthKey(shiftMonth(omarStart.year, omarStart.month, 2).year, shiftMonth(omarStart.year, omarStart.month, 2).month)}-28`),
      decisionNote: 'Repaid through payroll before Pollux HR went live.',
      installments: {
        create: [0, 1, 2].map((index) => {
          const month = shiftMonth(omarStart.year, omarStart.month, index);
          return {
            sequence: index + 1,
            dueMonth: d(`${monthKey(month.year, month.month)}-01`),
            amount: new Prisma.Decimal(500),
            status: 'DEDUCTED' as const,
            deductedAt: d(`${monthKey(month.year, month.month)}-28`),
          };
        }),
      },
    },
  });


  // Ahmed: 3,000 AED repaid in six instalments of 500, starting last month.
  const ahmedAdvance = (await requestAdvance(ahmed, { amount: 3000, reason: 'Car repair after an accident', requestedInstallments: 6 }, SEED)) as { id: string };
  await approveAdvance(hr, ahmedAdvance.id, { numberOfInstallments: 6, repaymentStartMonth: monthKey(PREV.year, PREV.month), note: 'Approved over six months.' }, SEED);
  await markAdvancePaid(hr, ahmedAdvance.id, { paymentReference: 'TRX-ADV-0001' }, SEED);
  const advanceRequested = addDaysToKey(PREV_START, -16);
  await prisma.salaryAdvance.update({
    where: { id: ahmedAdvance.id },
    data: {
      requestDate: d(advanceRequested),
      approvedAt: d(addDaysToKey(advanceRequested, 1)),
      paidAt: d(addDaysToKey(advanceRequested, 3)),
    },
  });

  // Layla: waiting for HR - approve it from Payroll > Salary Advances.
  await requestAdvance(layla, { amount: 3000, reason: 'School fees for the new term', requestedInstallments: 6 }, SEED);

  // Daniel (still on probation): filed by HR, declined by the general manager.
  const danielAdvance = (await requestAdvance(hr, { amount: 2000, reason: 'Rent deposit', requestedInstallments: 4, employeeId: id('PLX-0006') }, SEED)) as { id: string };
  await rejectAdvance(admin, danielAdvance.id, 'Advances are available after the probation period.', SEED);

  // --- Bonuses and deductions ----------------------------------------------------------
  // Entered by HR, approved by the general manager (four eyes on money).
  const bonus = (await createAdjustment(
    hr,
    { employeeId: id('PLX-0004'), payrollMonth: monthKey(PREV.year, PREV.month), type: 'BONUS', description: 'Sales bonus - 3 vehicles above target', amount: 300 },
    SEED,
  )) as { id: string };
  await approveAdjustment(admin, bonus.id, 'Confirmed against the sales report.', SEED);

  const fuel = (await createAdjustment(
    hr,
    { employeeId: id('PLX-0010'), payrollMonth: monthKey(YEAR, MONTH), type: 'ALLOWANCE', description: 'Fuel allowance - government visits', amount: 300 },
    SEED,
  )) as { id: string };
  await approveAdjustment(admin, fuel.id, undefined, SEED);

  // Waiting for approval.
  await createAdjustment(
    hr,
    { employeeId: id('PLX-0005'), payrollMonth: monthKey(YEAR, MONTH), type: 'COMMISSION', description: 'Fleet deal commission - Demo Logistics LLC', amount: 1200 },
    SEED,
  );

  // --- Payroll -------------------------------------------------------------------------
  // Last month: calculated and reviewed by HR, approved by the general manager,
  // paid through the bank. This generates every payslip as a stored PDF.
  const previous = (await createPeriod(hr, { year: PREV.year, month: PREV.month }, SEED)) as { id: string };
  await calculatePeriod(hr, previous.id, SEED, NOW);
  await reviewPeriod(hr, previous.id, SEED);
  await approvePeriod(admin, previous.id, SEED, NOW);
  const payDay = `${monthKey(PREV.year, PREV.month)}-${pad(Math.min(settings.payrollDay, lastDay(PREV.year, PREV.month)))}`;
  await markPeriodPaid(hr, previous.id, { paidOn: payDay, paymentReference: `WPS-${monthKey(PREV.year, PREV.month)}` }, SEED);

  // This month: calculated from attendance so far, waiting for review.
  const current = (await createPeriod(hr, { year: YEAR, month: MONTH }, SEED)) as { id: string };
  await calculatePeriod(hr, current.id, SEED, NOW);

  const ahmedRecord = await prisma.payrollRecord.findFirstOrThrow({
    where: { periodId: previous.id, employeeId: id('PLX-0004') },
    select: { grossEarnings: true, totalDeductions: true, netSalary: true },
  });
  const periods = await prisma.payrollPeriod.findMany({ orderBy: [{ year: 'asc' }, { month: 'asc' }] });
  for (const period of periods) {
    console.log(`  payroll ${period.name}: ${period.status}, ${period.employeeCount} employees, net AED ${period.totalNet.toFixed(2)}`);
  }
  console.log(
    `  Ahmed Nabil, ${periods[0]?.name}: gross ${ahmedRecord.grossEarnings.toFixed(2)}, deductions ${ahmedRecord.totalDeductions.toFixed(2)}, net ${ahmedRecord.netSalary.toFixed(2)}`,
  );

  console.log('\nDemo accounts (password from SEED_DEMO_PASSWORD):');
  for (const person of EMPLOYEES.filter((candidate) => candidate.login)) {
    console.log(`  ${person.login?.role.padEnd(9)} ${person.login?.email.padEnd(28)} ${person.first} ${person.last}, ${person.job}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
