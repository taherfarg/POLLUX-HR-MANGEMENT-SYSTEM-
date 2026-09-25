import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asUser, createFixture, login, resetDatabase } from './fixture';
import request from 'supertest';
import { prisma } from '../src/db/prisma';
import { addDaysToKey, zonedDateKey } from '../src/services/timezone';
import { parseSetupAccounts, runSetup, SetupError, type SetupAccount } from '../prisma/setup';

/**
 * `npm run db:setup` - the clean start for real use: the demo cleared, the
 * company's configuration created, and only the accounts named in the
 * environment able to sign in.
 */

const PASSWORD = 'CleanStart2026';
const TODAY = zonedDateKey(new Date(), 'Asia/Dubai');
const YEAR = Number(TODAY.slice(0, 4));

const ENV = {
  SETUP_ADMINS: `Amal Rahman|Amal.Rahman@Example.com|${PASSWORD}|HR Manager`,
  SETUP_MANAGERS: `Omar Said|omar.said@example.com|${PASSWORD}`,
  SETUP_EMPLOYEES: `Lina Haddad|lina.haddad@example.com|${PASSWORD}|Sales Executive; Karim Nasser|karim.nasser@example.com|${PASSWORD}||${YEAR}-07-01`,
};

describe('clean start (db:setup)', () => {
  describe('reading the accounts', () => {
    it('reads every role, with defaults for the optional parts', () => {
      const accounts = parseSetupAccounts(ENV);
      expect(accounts.map((account) => [account.role, account.email, account.firstName, account.lastName, account.jobTitle, account.hireDate])).toEqual([
        ['ADMIN', 'amal.rahman@example.com', 'Amal', 'Rahman', 'HR Manager', null],
        ['MANAGER', 'omar.said@example.com', 'Omar', 'Said', 'Manager', null],
        ['EMPLOYEE', 'lina.haddad@example.com', 'Lina', 'Haddad', 'Sales Executive', null],
        ['EMPLOYEE', 'karim.nasser@example.com', 'Karim', 'Nasser', 'Employee', `${YEAR}-07-01`],
      ]);
    });

    it('reports every problem at once, without echoing a password', () => {
      const attempt = () =>
        parseSetupAccounts({
          SETUP_ADMINS: 'Amal Rahman|amal@example.com|weakpassword1',
          SETUP_EMPLOYEES: `Lina|lina@@example|${PASSWORD}|Sales Executive|2026-13-40;Karim Nasser|karim@example.com`,
        });
      expect(attempt).toThrow(SetupError);
      try {
        attempt();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('SETUP_ADMINS, entry 1: the password does not meet the password policy - Password must contain an uppercase letter');
        expect(message).toContain('SETUP_EMPLOYEES, entry 1: give a first and a last name');
        expect(message).toContain('SETUP_EMPLOYEES, entry 1: the second part is not a valid email address');
        expect(message).toContain('SETUP_EMPLOYEES, entry 1: the hire date (fifth part) is not a date in YYYY-MM-DD format');
        expect(message).toContain('SETUP_EMPLOYEES, entry 2: expected "Full name|email|password"');
        expect(message).not.toContain('weakpassword1');
        expect(message).not.toContain(PASSWORD);
      }
    });

    it('never echoes a password typed in the wrong place', () => {
      const swapped = () => parseSetupAccounts({ SETUP_ADMINS: `Amal Rahman|${PASSWORD}|amal@example.com||${PASSWORD}` });
      expect(swapped).toThrow(SetupError);
      expect(() => swapped()).not.toThrow(new RegExp(PASSWORD));
    });

    it('needs an administrator, and each email once', () => {
      expect(() => parseSetupAccounts({ SETUP_MANAGERS: ENV.SETUP_MANAGERS })).toThrow(/At least one administrator is needed/);
      expect(() => parseSetupAccounts({})).toThrow(/No accounts were given/);
      expect(() =>
        parseSetupAccounts({ SETUP_ADMINS: ENV.SETUP_ADMINS, SETUP_EMPLOYEES: `Amal Other|AMAL.RAHMAN@example.com|${PASSWORD}` }),
      ).toThrow('amal.rahman@example.com is listed more than once');
    });
  });

  describe('setting up over the demo', () => {
    let accounts: SetupAccount[];

    beforeAll(async () => {
      await resetDatabase();
      await createFixture(); // demo-style data, all on `.demo` addresses
      accounts = parseSetupAccounts(ENV);
      await runSetup(prisma, accounts, { today: TODAY, allowWipe: false });
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('leaves only the company and the people named', async () => {
      const [entities, employees, users, departments, attendance, payroll, requests, salaries, advances] = await Promise.all([
        prisma.legalEntity.findMany({ include: { settings: true } }),
        prisma.employee.findMany({ include: { user: true, manager: true }, orderBy: { employeeNumber: 'asc' } }),
        prisma.user.count(),
        prisma.department.count(),
        prisma.attendanceRecord.count(),
        prisma.payrollPeriod.count(),
        prisma.request.count(),
        prisma.compensationRecord.count(),
        prisma.salaryAdvance.count(),
      ]);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.legalName).toBe('POLLUX MOTORS FZE');
      expect(entities[0]?.settings).toMatchObject({ isPrimary: true, employeeNumberPrefix: 'PLX' });
      // The day of setup never counts as an absence, whatever the hour it runs.
      expect(entities[0]?.settings?.attendanceStartDate?.toISOString().slice(0, 10)).toBe(addDaysToKey(TODAY, 1));
      expect([users, departments, attendance, payroll, requests, salaries, advances]).toEqual([4, 0, 0, 0, 0, 0, 0]);

      expect(employees.map((employee) => [employee.employeeNumber, employee.workEmail, employee.user?.role, employee.status, employee.manager?.firstName ?? null])).toEqual([
        ['PLX-0001', 'amal.rahman@example.com', 'ADMIN', 'ACTIVE', null],
        ['PLX-0002', 'omar.said@example.com', 'MANAGER', 'ACTIVE', null],
        ['PLX-0003', 'lina.haddad@example.com', 'EMPLOYEE', 'ACTIVE', 'Omar'],
        // Joined on 1 July: six months' probation runs to 1 January.
        ['PLX-0004', 'karim.nasser@example.com', 'EMPLOYEE', 'PROBATION', 'Omar'],
      ]);
    });

    it('lets each account sign in, and nobody from the demo', async () => {
      for (const account of accounts) {
        await expect(login(account.email, PASSWORD)).resolves.toEqual(expect.any(String));
      }
      const demo = await request(app).post('/api/v1/auth/login').send({ email: 'admin@test.demo', password: 'TestPassw0rd!' });
      expect(demo.status).toBe(401);
    });

    it('does not hold the day of setup against anyone', async () => {
      const today = await asUser(await login('lina.haddad@example.com', PASSWORD)).get('/api/v1/attendance/today');
      expect(today.status).toBe(200);
      expect(today.body.data.trackingStartsOn).toBe(addDaysToKey(TODAY, 1));
      expect(today.body.data.today?.status).not.toBe('ABSENT');
    });

    it('gives a full year of leave to existing staff and pro-rates a joiner', async () => {
      const balances = await prisma.leaveBalance.findMany({
        where: { year: YEAR, leaveType: { code: 'ANNUAL' } },
        include: { employee: { select: { employeeNumber: true } } },
        orderBy: { employee: { employeeNumber: 'asc' } },
      });
      expect(balances.map((balance) => [balance.employee.employeeNumber, balance.entitledDays.toNumber()])).toEqual([
        ['PLX-0001', 30],
        ['PLX-0002', 30],
        ['PLX-0003', 30],
        ['PLX-0004', 15], // July to December
      ]);
      // Gender is unknown at setup, so no gender-restricted balance yet.
      expect(await prisma.leaveBalance.count({ where: { leaveType: { code: 'MATERNITY' } } })).toBe(0);
    });

    it('lets a lone administrator run payroll from calculation to approval', async () => {
      const settings = await prisma.companySettings.findFirstOrThrow();
      expect(settings.payrollRequiresSeparateApprover).toBe(false);

      const admin = asUser(await login('amal.rahman@example.com', PASSWORD));
      const lina = await prisma.employee.findUniqueOrThrow({ where: { workEmail: 'lina.haddad@example.com' } });
      const salary = await admin.post(`/api/v1/employees/${lina.id}/compensation`).send({
        baseSalary: 6000, housingAllowance: 0, transportAllowance: 0, otherAllowances: 0,
        effectiveFrom: TODAY, changeReason: 'Starting salary',
      });
      expect(salary.status).toBe(201);

      const period = await admin.post('/api/v1/payroll/periods').send({ year: YEAR, month: Number(TODAY.slice(5, 7)) });
      expect(period.status).toBe(201);
      for (const step of ['calculate', 'review', 'approve']) {
        const response = await admin.post(`/api/v1/payroll/periods/${period.body.data.id}/${step}`);
        expect(response.status, `${step}: ${JSON.stringify(response.body)}`).toBe(200);
      }
    });

    it('records the setup in the audit trail', async () => {
      const entries = await prisma.auditLog.findMany({ where: { userAgent: 'pollux-setup' }, orderBy: { createdAt: 'asc' } });
      expect(entries).toHaveLength(5);
      expect(entries[0]?.actorLabel).toBe('System (db:setup)');
      expect(entries.map((entry) => entry.summary).join('\n')).not.toContain(PASSWORD);
    });

    it('refuses to replace real data unless told to', async () => {
      await expect(runSetup(prisma, accounts, { today: TODAY, allowWipe: false })).rejects.toThrow(/already holds real data/);
      expect(await prisma.payrollPeriod.count()).toBe(1); // untouched

      const two = parseSetupAccounts({ ...ENV, SETUP_HR: `Nadia Karam|nadia.karam@example.com|${PASSWORD}` });
      await runSetup(prisma, two, { today: TODAY, allowWipe: true });
      expect(await prisma.payrollPeriod.count()).toBe(0);
      expect(await prisma.user.count()).toBe(5);
      // Two people can approve now, so payroll keeps four eyes.
      expect((await prisma.companySettings.findFirstOrThrow()).payrollRequiresSeparateApprover).toBe(true);
    });
  });
});
