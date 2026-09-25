/**
 * Clean start for Pollux HR: POLLUX MOTORS FZE with only the people you name.
 *
 * The demo seed (`npm run db:seed`) fills the database with a fictional
 * company. This is its counterpart for real use: it clears the database and
 * creates the company's working configuration and the accounts passed in - no
 * demo employees, attendance, leave, advances or payroll.
 *
 * What it creates:
 *   - POLLUX MOTORS FZE, Dubai: AED, Asia/Dubai, Monday to Friday
 *   - one work location (Dubai Office) and one schedule, the company default:
 *     Monday to Friday, 09:00-18:00, one-hour break
 *   - the UAE's fixed-date public holidays, recurring every year. Islamic
 *     holidays move with the moon and are announced close to the date, so HR
 *     adds them each year once they are confirmed
 *   - the standard leave types, and this year's balances for every person
 *   - company settings at their defaults, with attendance tracked from the day
 *     after setup: the day it runs never counts as an absence, whatever the hour
 *   - an employee record and a login for each account
 *
 * The accounts come from environment variables, so real email addresses and
 * passwords are never written into the repository:
 *
 *   SETUP_ADMINS     administrators: everything, including company settings
 *   SETUP_HR         HR: people, time, leave and payroll, not company settings
 *   SETUP_MANAGERS   line managers: their team's time and leave, never pay
 *   SETUP_EMPLOYEES  employees: their own record; they report to the first manager
 *
 * One or more entries per variable, separated by ";", each
 *
 *   Full name|email|password|Job title|Hire date (YYYY-MM-DD)
 *
 * where the job title and the hire date are optional. Without a hire date the
 * person is recorded as an existing, active employee as of today, with the full
 * year's leave. Payroll pays from the hire date, so set the real one in their
 * file before the first payroll.
 *
 * With a single HR or administrator account nobody else could approve a
 * payroll, so the separate-approver rule starts switched off; switch it on in
 * Settings -> Payroll once a second person can approve.
 *
 * Like the seed, this replaces everything in the database it points at. It
 * refuses to run over anything but demo data unless SETUP_ALLOW_WIPE=yes, and
 * it runs as one transaction: it either completes or changes nothing.
 *
 * Run with:  npm run db:setup
 */
import { config as loadEnvFile } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@prisma/client';
import { dateStringSchema, emailSchema } from '../src/common/validate';
import { hashPassword, passwordSchema } from '../src/modules/auth/password';
import { addDaysToKey, zonedDateKey } from '../src/services/timezone';

const COMPANY_TZ = 'Asia/Dubai';

const COMPANY = {
  code: 'PLX-AE',
  name: 'Pollux Motors',
  legalName: 'POLLUX MOTORS FZE',
  // Printed on payslips and letters; an administrator enters the real number
  // in Settings -> Company.
  registrationNumber: 'Not set',
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
  city: 'Dubai',
  currency: 'AED',
  timezone: COMPANY_TZ,
  workWeek: [1, 2, 3, 4, 5],
  weeklyHours: 40,
  probationMonths: 6,
  noticePeriodDays: 30,
};

const EMPLOYEE_NUMBER_PREFIX = 'PLX';

const LOCATION = {
  code: 'DXB-OFFICE',
  name: 'Dubai Office',
  kind: 'OFFICE',
  city: 'Dubai',
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
  timezone: COMPANY_TZ,
} as const;

const SCHEDULE = {
  code: 'STD-DXB',
  name: 'Standard Dubai Office',
  description: 'Monday to Friday, 09:00-18:00 Dubai time, one-hour break',
  timezone: COMPANY_TZ,
  workingDays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  breakMinutes: 60,
};

const CALENDAR = {
  code: 'UAE',
  name: 'UAE Public Holidays',
  countryCode: 'AE',
  description: 'UAE public holidays. Fixed-date holidays repeat every year; add the Islamic holidays once they are announced.',
};

/** Fixed-date UAE public holidays, stored once and recurring every year. */
const FIXED_HOLIDAYS = [
  { name: "New Year's Day", monthDay: '01-01' },
  { name: 'Commemoration Day', monthDay: '12-01' },
  { name: 'UAE National Day', monthDay: '12-02' },
  { name: 'UAE National Day Holiday', monthDay: '12-03' },
];

/** The demo's leave policy. HR can change every figure in Settings -> Leave types. */
const LEAVE_TYPES = [
  { code: 'ANNUAL', name: 'Annual Leave', days: 30, colour: '#2563eb', paid: true, halfDay: true, notice: 7, carryOver: 10 },
  { code: 'SICK', name: 'Sick Leave', days: 15, colour: '#dc2626', paid: true, halfDay: true, notice: 0, carryOver: 0, attachment: true },
  { code: 'UNPAID', name: 'Unpaid Leave', days: 30, colour: '#64748b', paid: false, halfDay: true, notice: 3, carryOver: 0 },
  { code: 'PARENTAL', name: 'Parental Leave', days: 5, colour: '#7c3aed', paid: true, halfDay: false, notice: 0, carryOver: 0 },
  { code: 'MATERNITY', name: 'Maternity Leave', days: 60, colour: '#db2777', paid: true, halfDay: false, notice: 30, carryOver: 0, gender: 'FEMALE' as const },
  { code: 'BEREAVEMENT', name: 'Bereavement Leave', days: 5, colour: '#475569', paid: true, halfDay: false, notice: 0, carryOver: 0 },
];

const ROLE_SOURCES: readonly { variable: string; role: Role; defaultTitle: string }[] = [
  { variable: 'SETUP_ADMINS', role: 'ADMIN', defaultTitle: 'Administrator' },
  { variable: 'SETUP_HR', role: 'HR_ADMIN', defaultTitle: 'HR Officer' },
  { variable: 'SETUP_MANAGERS', role: 'MANAGER', defaultTitle: 'Manager' },
  { variable: 'SETUP_EMPLOYEES', role: 'EMPLOYEE', defaultTitle: 'Employee' },
];

const SETUP_ACTOR = 'System (db:setup)';
const SETUP_USER_AGENT = 'pollux-setup';

export interface SetupAccount {
  role: Role;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  jobTitle: string;
  /** YYYY-MM-DD, or null when not given. */
  hireDate: string | null;
}

export interface SetupOptions {
  /** The company's date today, YYYY-MM-DD in Dubai. */
  today: string;
  /** Replace a database that holds more than demo data. */
  allowWipe: boolean;
}

export interface SetupResult {
  company: string;
  attendanceStartDate: string;
  separateApprover: boolean;
  holidays: number;
  leaveTypes: number;
  accounts: {
    role: Role;
    email: string;
    name: string;
    jobTitle: string;
    employeeNumber: string;
    hireDate: string | null;
    reportsTo: string | null;
  }[];
}

/** A problem with the input or the target database, found before anything was written. */
export class SetupError extends Error {}

/**
 * Reads the accounts from SETUP_ADMINS, SETUP_HR, SETUP_MANAGERS and
 * SETUP_EMPLOYEES. Every entry is checked before anything is written, and
 * every problem is reported at once - never the passwords themselves.
 */
export function parseSetupAccounts(env: Record<string, string | undefined>): SetupAccount[] {
  const accounts: SetupAccount[] = [];
  const problems: string[] = [];

  for (const source of ROLE_SOURCES) {
    const entries = (env[source.variable] ?? '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean);

    entries.forEach((entry, index) => {
      const where = `${source.variable}, entry ${index + 1}`;
      const fields = entry.split('|').map((field) => field.trim());
      if (fields.length < 3 || fields.length > 5) {
        problems.push(
          `${where}: expected "Full name|email|password", optionally followed by "|Job title|YYYY-MM-DD" - found ${fields.length} part(s)`,
        );
        return;
      }
      const [name = '', email = '', password = '', title = '', hireDate = ''] = fields;
      const before = problems.length;

      const names = name.split(/\s+/).filter(Boolean);
      const firstName = names[0] ?? '';
      const lastName = names.slice(1).join(' ');
      if (!firstName || !lastName) {
        problems.push(`${where}: give a first and a last name, for example "Sara Haddad"`);
      } else if (firstName.length > 80 || lastName.length > 80) {
        problems.push(`${where}: the name is too long`);
      }

      // Values are not echoed: with the parts in the wrong order, the "email"
      // or the "hire date" may well be the password.
      const parsedEmail = emailSchema.safeParse(email);
      if (!parsedEmail.success) problems.push(`${where}: the second part is not a valid email address`);

      const parsedPassword = passwordSchema.safeParse(password);
      if (!parsedPassword.success) {
        const rules = parsedPassword.error.issues.map((issue) => issue.message).join('; ');
        problems.push(`${where}: the password does not meet the password policy - ${rules}`);
      }

      const jobTitle = title || source.defaultTitle;
      if (jobTitle.length < 2 || jobTitle.length > 120) {
        problems.push(`${where}: the job title must be 2 to 120 characters`);
      }

      if (hireDate && !dateStringSchema.safeParse(hireDate).success) {
        problems.push(`${where}: the hire date (fifth part) is not a date in YYYY-MM-DD format`);
      }

      if (problems.length > before || !parsedEmail.success) return;
      accounts.push({
        role: source.role,
        firstName,
        lastName,
        email: parsedEmail.data,
        password,
        jobTitle,
        hireDate: hireDate || null,
      });
    });
  }

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.email)) problems.push(`${account.email} is listed more than once`);
    seen.add(account.email);
  }

  if (problems.length === 0) {
    if (accounts.length === 0) {
      problems.push('No accounts were given. Set SETUP_ADMINS, and SETUP_HR, SETUP_MANAGERS or SETUP_EMPLOYEES as needed.');
    } else if (!accounts.some((account) => account.role === 'ADMIN')) {
      problems.push('At least one administrator is needed (SETUP_ADMINS): only an administrator can change company settings.');
    }
  }

  if (problems.length > 0) throw new SetupError(problems.join('\n'));
  return accounts;
}

const day = (key: string): Date => new Date(`${key}T00:00:00.000Z`);
const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

/** The same probation arithmetic as creating an employee in the app. */
function probationEnd(hireDate: string): string {
  const hire = day(hireDate);
  return dateKey(new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth() + COMPANY.probationMonths, hire.getUTCDate())));
}

/**
 * The year's entitlement: the full year for someone already employed, the
 * months left for someone joining this year, rounded to the nearest half day -
 * the same rule as creating an employee in the app.
 */
function entitlement(annualDays: number, hireDate: string | null, year: number): Prisma.Decimal {
  const monthsRemaining = hireDate && Number(hireDate.slice(0, 4)) === year ? 12 - (Number(hireDate.slice(5, 7)) - 1) : 12;
  return new Prisma.Decimal(Math.round(((annualDays * monthsRemaining) / 12) * 2) / 2);
}

/** People and logins that are not the demo's `.demo` addresses - real data. */
async function countRealRecords(client: PrismaClient): Promise<{ people: number; logins: number }> {
  const [people, logins] = await Promise.all([
    client.employee.count({ where: { NOT: { workEmail: { endsWith: '.demo' } } } }),
    client.user.count({ where: { NOT: { email: { endsWith: '.demo' } } } }),
  ]);
  return { people, logins };
}

/** Every table, children first - the same order as the seed's reset. */
async function clearDatabase(tx: Prisma.TransactionClient): Promise<void> {
  await tx.overtimeEntry.deleteMany();
  await tx.salaryAdvanceInstallment.deleteMany();
  await tx.payrollAdjustment.deleteMany();
  await tx.payrollItem.deleteMany();
  await tx.payrollRecord.deleteMany();
  await tx.payrollPeriod.deleteMany();
  await tx.salaryAdvance.deleteMany();
  await tx.attendanceRecord.deleteMany();
  await tx.documentFile.deleteMany();
  await tx.auditLog.deleteMany();
  await tx.notification.deleteMany();
  await tx.leaveRequestDetail.deleteMany();
  await tx.documentRequestDetail.deleteMany();
  await tx.profileChangeRequestDetail.deleteMany();
  await tx.request.deleteMany();
  await tx.leaveBalance.deleteMany();
  await tx.document.deleteMany();
  await tx.employmentEvent.deleteMany();
  await tx.compensationRecord.deleteMany();
  await tx.refreshToken.deleteMany();
  await tx.user.deleteMany();
  await tx.holiday.deleteMany();
  await tx.leaveType.deleteMany();
  // Self-references first, then the rows they point at.
  await tx.department.updateMany({ data: { headId: null } });
  await tx.employee.updateMany({ data: { managerId: null } });
  await tx.employee.deleteMany();
  await tx.department.deleteMany();
  await tx.companySettings.deleteMany();
  await tx.workScheduleDay.deleteMany();
  await tx.workSchedule.deleteMany();
  await tx.workLocation.deleteMany();
  await tx.holidayCalendar.deleteMany();
  await tx.legalEntity.deleteMany();
}

export async function runSetup(client: PrismaClient, accounts: SetupAccount[], options: SetupOptions): Promise<SetupResult> {
  const real = await countRealRecords(client);
  if ((real.people > 0 || real.logins > 0) && !options.allowWipe) {
    throw new SetupError(
      `This database already holds real data: ${real.people} employee record(s) and ${real.logins} login(s) that are not demo accounts.\n` +
        'Setup deletes everything in it. To really start over, run it again with SETUP_ALLOW_WIPE=yes.',
    );
  }

  // bcrypt is deliberately slow; hash before the transaction so it holds its
  // locks only for the writes.
  const passwordHashes = await Promise.all(accounts.map((account) => hashPassword(account.password)));

  // Four eyes on payroll needs two people who can approve one.
  const approvers = accounts.filter((account) => account.role === 'ADMIN' || account.role === 'HR_ADMIN').length;
  const separateApprover = approvers >= 2;
  const year = Number(options.today.slice(0, 4));
  // Check-ins on the day of setup are still recorded; only a missing one is
  // not held against anyone.
  const attendanceStartDate = addDaysToKey(options.today, 1);

  return client.$transaction(
    async (tx) => {
      await clearDatabase(tx);

      const entity = await tx.legalEntity.create({
        data: { ...COMPANY, weeklyHours: new Prisma.Decimal(COMPANY.weeklyHours), establishedOn: day(options.today) },
      });
      const location = await tx.workLocation.create({ data: { ...LOCATION, legalEntityId: entity.id } });
      const schedule = await tx.workSchedule.create({
        data: {
          legalEntityId: entity.id,
          code: SCHEDULE.code,
          name: SCHEDULE.name,
          description: SCHEDULE.description,
          timezone: SCHEDULE.timezone,
          days: {
            create: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) =>
              SCHEDULE.workingDays.includes(dayOfWeek)
                ? { dayOfWeek, isWorkingDay: true, startMinute: SCHEDULE.startMinute, endMinute: SCHEDULE.endMinute, breakMinutes: SCHEDULE.breakMinutes }
                : { dayOfWeek, isWorkingDay: false, startMinute: null, endMinute: null, breakMinutes: 0 },
            ),
          },
        },
      });
      const calendar = await tx.holidayCalendar.create({ data: { ...CALENDAR, legalEntityId: entity.id } });
      await tx.holiday.createMany({
        data: FIXED_HOLIDAYS.map((holiday) => ({
          legalEntityId: entity.id,
          calendarId: calendar.id,
          name: holiday.name,
          date: day(`${year}-${holiday.monthDay}`),
          type: 'PUBLIC' as const,
          isRecurringAnnually: true,
        })),
      });

      await tx.companySettings.create({
        data: {
          legalEntityId: entity.id,
          isPrimary: true,
          displayName: COMPANY.name,
          employeeNumberPrefix: EMPLOYEE_NUMBER_PREFIX,
          defaultWorkScheduleId: schedule.id,
          defaultHolidayCalendarId: calendar.id,
          attendanceStartDate: day(attendanceStartDate),
          payrollRequiresSeparateApprover: separateApprover,
        },
      });

      await tx.leaveType.createMany({
        data: LEAVE_TYPES.map((type) => ({
          legalEntityId: entity.id,
          code: type.code,
          name: type.name,
          colorHex: type.colour,
          annualEntitlementDays: new Prisma.Decimal(type.days),
          isPaid: type.paid,
          requiresAttachment: type.attachment ?? false,
          allowsHalfDay: type.halfDay,
          minNoticeDays: type.notice,
          carryOverMaxDays: new Prisma.Decimal(type.carryOver),
          restrictedToGender: type.gender ?? null,
        })),
      });
      // Gender is not asked for here, so gender-restricted types get their
      // balance once HR records it (Leave balances -> Generate).
      const leaveTypes = await tx.leaveType.findMany({
        where: { legalEntityId: entity.id, restrictedToGender: null },
        select: { id: true, annualEntitlementDays: true },
      });

      const people: SetupResult['accounts'] = [];
      const employeeIds: string[] = [];
      for (const [index, account] of accounts.entries()) {
        const employeeNumber = `${EMPLOYEE_NUMBER_PREFIX}-${String(index + 1).padStart(4, '0')}`;
        const probationEndKey = account.hireDate ? probationEnd(account.hireDate) : null;
        const employee = await tx.employee.create({
          data: {
            employeeNumber,
            firstName: account.firstName,
            lastName: account.lastName,
            workEmail: account.email,
            legalEntityId: entity.id,
            jobTitle: account.jobTitle,
            status: probationEndKey && probationEndKey > options.today ? 'PROBATION' : 'ACTIVE',
            hireDate: day(account.hireDate ?? options.today),
            probationEndDate: probationEndKey ? day(probationEndKey) : null,
            noticePeriodDays: COMPANY.noticePeriodDays,
            workLocationId: location.id,
            // Schedule and holiday calendar are left to the company defaults.
          },
        });
        await tx.user.create({
          data: {
            email: account.email,
            passwordHash: passwordHashes[index] as string,
            role: account.role,
            employeeId: employee.id,
          },
        });
        if (account.hireDate) {
          await tx.employmentEvent.create({
            data: { employeeId: employee.id, type: 'HIRED', effectiveDate: day(account.hireDate), title: `Joined as ${account.jobTitle}` },
          });
        }
        await tx.leaveBalance.createMany({
          data: leaveTypes.map((type) => ({
            employeeId: employee.id,
            leaveTypeId: type.id,
            year,
            entitledDays: entitlement(type.annualEntitlementDays.toNumber(), account.hireDate, year),
          })),
        });
        employeeIds.push(employee.id);
        people.push({
          role: account.role,
          email: account.email,
          name: `${account.firstName} ${account.lastName}`,
          jobTitle: account.jobTitle,
          employeeNumber,
          hireDate: account.hireDate,
          reportsTo: null,
        });
      }

      // Employees report to the first manager; HR can change any reporting
      // line from the employee's file.
      const managerIndex = people.findIndex((person) => person.role === 'MANAGER');
      if (managerIndex >= 0) {
        const manager = people[managerIndex] as SetupResult['accounts'][number];
        const reportIds: string[] = [];
        people.forEach((person, index) => {
          if (person.role !== 'EMPLOYEE') return;
          person.reportsTo = manager.name;
          reportIds.push(employeeIds[index] as string);
        });
        await tx.employee.updateMany({ where: { id: { in: reportIds } }, data: { managerId: employeeIds[managerIndex] as string } });
      }

      await tx.auditLog.createMany({
        data: [
          {
            actorLabel: SETUP_ACTOR,
            action: 'CREATE' as const,
            entityType: 'LegalEntity',
            entityId: entity.id,
            legalEntityId: entity.id,
            summary: `Pollux HR set up for ${COMPANY.legalName} with ${people.length} account(s); earlier data cleared`,
            after: { attendanceStartDate, payrollRequiresSeparateApprover: separateApprover },
            userAgent: SETUP_USER_AGENT,
          },
          ...people.map((person, index) => ({
            actorLabel: SETUP_ACTOR,
            action: 'CREATE' as const,
            entityType: 'Employee',
            entityId: employeeIds[index] as string,
            legalEntityId: entity.id,
            summary: `Created employee ${person.employeeNumber} - ${person.name}, login ${person.email} (${person.role})`,
            after: { employeeNumber: person.employeeNumber, jobTitle: person.jobTitle, email: person.email, role: person.role },
            userAgent: SETUP_USER_AGENT,
          })),
        ],
      });

      return {
        company: COMPANY.legalName,
        attendanceStartDate,
        separateApprover,
        holidays: FIXED_HOLIDAYS.length,
        leaveTypes: LEAVE_TYPES.length,
        accounts: people,
      };
    },
    // Generous limits: run from a laptop against a database on another
    // continent, each of the few dozen statements is a round trip.
    { maxWait: 30_000, timeout: 10 * 60_000 },
  );
}

function printSummary(result: SetupResult): void {
  console.log(`\nPollux HR is ready for ${result.company}.`);
  console.log(`  ${LOCATION.name}; ${SCHEDULE.name} schedule (Mon-Fri 09:00-18:00); ${result.holidays} fixed-date UAE holidays; ${result.leaveTypes} leave types`);
  console.log(`  Attendance tracked from ${result.attendanceStartDate} (Settings -> Attendance to change)`);
  console.log(
    result.separateApprover
      ? '  Payroll: calculated by one person, approved by another'
      : '  Payroll: one person may calculate and approve (a single HR/administrator account).\n' +
          '           Require a second approver in Settings -> Payroll once two people can approve.',
  );

  console.log('\nAccounts:');
  for (const account of result.accounts) {
    const line = `  ${account.role.padEnd(9)} ${account.email.padEnd(32)} ${account.employeeNumber}  ${account.name}, ${account.jobTitle}`;
    console.log(account.reportsTo ? `${line} - reports to ${account.reportsTo}` : line);
  }

  console.log('\nNext, signed in as an administrator:');
  console.log('  - Settings -> Company: the trade licence / registration number and the address');
  if (result.accounts.some((account) => !account.hireDate)) {
    console.log("  - Each person's file: the real hire date, and the salary, before the first payroll");
  } else {
    console.log("  - Each person's file: the salary, before the first payroll");
  }
  console.log('  - Holidays: add the Islamic holidays once they are announced');
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    throw new SetupError('DATABASE_URL is not set. Point it at the database to set up, for example the Neon connection string.');
  }
  const accounts = parseSetupAccounts(process.env);
  const today = zonedDateKey(new Date(), COMPANY_TZ);
  const allowWipe = /^(yes|true)$/i.test(process.env.SETUP_ALLOW_WIPE ?? '');

  const client = new PrismaClient();
  try {
    console.log(`Setting up Pollux HR for ${COMPANY.legalName} (today in Dubai: ${today})...`);
    printSummary(await runSetup(client, accounts, { today, allowWipe }));
  } finally {
    await client.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof SetupError) {
      console.error(`\nSetup stopped before changing anything:\n${error.message}`);
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
      console.error('\nThe database has no tables yet. Run `npx prisma migrate deploy` first, then run the setup again.');
    } else {
      console.error(error);
      console.error('\nThe setup runs as one transaction, so a failure leaves the database as it was.');
    }
    process.exitCode = 1;
  });
}
