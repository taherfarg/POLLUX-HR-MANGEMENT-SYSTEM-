import type { Express } from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/db/prisma';
import { hashPassword } from '../src/modules/auth/password';

export const TEST_PASSWORD = 'TestPassw0rd!';

export const app: Express = createApp();

/** Empties every table in dependency order. Called before each test file. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
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
  await prisma.department.updateMany({ data: { headId: null } });
  await prisma.employee.updateMany({ data: { managerId: null } });
  await prisma.employee.deleteMany();
  await prisma.department.deleteMany();
  // Pollux organisation structure: settings point at schedules and calendars,
  // so they go first.
  await prisma.companySettings.deleteMany();
  await prisma.workScheduleDay.deleteMany();
  await prisma.workSchedule.deleteMany();
  await prisma.workLocation.deleteMany();
  await prisma.holidayCalendar.deleteMany();
  await prisma.legalEntity.deleteMany();
}

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export interface Fixture {
  entityAe: string;
  entitySa: string;
  annualAe: string;
  annualSa: string;
  sickAe: string;
  /** Employee ids */
  admin: string;
  hrKsa: string;
  manager: string;
  employee: string;
  colleague: string;
  ksaEmployee: string;
  emails: {
    admin: string;
    hrKsa: string;
    manager: string;
    employee: string;
    colleague: string;
    ksaEmployee: string;
  };
}

/**
 * A deliberately small organisation that still exercises every access rule:
 * two legal entities with different working weeks, a scoped HR admin, a manager
 * with one direct report, and a colleague the employee has no relationship to.
 */
export async function createFixture(): Promise<Fixture> {
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const entityAe = await prisma.legalEntity.create({
    data: {
      code: 'TST-AE', name: 'Test UAE', legalName: 'Test UAE LLC', registrationNumber: 'TEST-1',
      countryCode: 'AE', countryName: 'United Arab Emirates', city: 'Dubai', currency: 'AED',
      timezone: 'Asia/Dubai', workWeek: [1, 2, 3, 4, 5], weeklyHours: new Prisma.Decimal(40),
      establishedOn: date('2020-01-01'),
    },
  });

  const entitySa = await prisma.legalEntity.create({
    data: {
      code: 'TST-SA', name: 'Test KSA', legalName: 'Test KSA LLC', registrationNumber: 'TEST-2',
      countryCode: 'SA', countryName: 'Saudi Arabia', city: 'Riyadh', currency: 'SAR',
      timezone: 'Asia/Riyadh', workWeek: [0, 1, 2, 3, 4], weeklyHours: new Prisma.Decimal(40),
      establishedOn: date('2020-01-01'),
    },
  });

  const department = await prisma.department.create({
    data: { code: 'TSTENG', name: 'Engineering' },
  });

  const annualAe = await prisma.leaveType.create({
    data: {
      legalEntityId: entityAe.id, code: 'ANNUAL', name: 'Annual Leave',
      annualEntitlementDays: new Prisma.Decimal(20), minNoticeDays: 0,
    },
  });
  const sickAe = await prisma.leaveType.create({
    data: {
      legalEntityId: entityAe.id, code: 'SICK', name: 'Sick Leave',
      annualEntitlementDays: new Prisma.Decimal(10), minNoticeDays: 0,
    },
  });
  const annualSa = await prisma.leaveType.create({
    data: {
      legalEntityId: entitySa.id, code: 'ANNUAL', name: 'Annual Leave',
      annualEntitlementDays: new Prisma.Decimal(21), minNoticeDays: 0,
    },
  });

  // Holidays live in a calendar; with no settings row the entity's first
  // calendar is its default, exactly like an entity migrated from before
  // calendars existed.
  const calendarAe = await prisma.holidayCalendar.create({
    data: { legalEntityId: entityAe.id, code: 'TST-AE-HOLIDAYS', name: 'Test UAE Holidays', countryCode: 'AE' },
  });

  // A Wednesday, so it lands inside the working week of both entities.
  await prisma.holiday.create({
    data: { legalEntityId: entityAe.id, calendarId: calendarAe.id, name: 'Test Holiday', date: date('2026-11-04') },
  });

  const makeEmployee = async (input: {
    number: string;
    first: string;
    last: string;
    entityId: string;
    jobTitle: string;
    managerId?: string;
  }) =>
    prisma.employee.create({
      data: {
        employeeNumber: input.number,
        firstName: input.first,
        lastName: input.last,
        workEmail: `${input.first.toLowerCase()}.${input.last.toLowerCase()}@test.demo`,
        legalEntityId: input.entityId,
        departmentId: department.id,
        managerId: input.managerId ?? null,
        jobTitle: input.jobTitle,
        status: 'ACTIVE',
        hireDate: date('2023-01-09'),
        dateOfBirth: date('1990-05-05'),
        gender: 'UNDISCLOSED',
        phone: '+971 50 000 0000',
      },
    });

  const admin = await makeEmployee({ number: 'AE-0001', first: 'Ada', last: 'Admin', entityId: entityAe.id, jobTitle: 'Head of People' });
  const manager = await makeEmployee({ number: 'AE-0002', first: 'Mo', last: 'Manager', entityId: entityAe.id, jobTitle: 'Engineering Manager' });
  const employee = await makeEmployee({ number: 'AE-0003', first: 'Eve', last: 'Employee', entityId: entityAe.id, jobTitle: 'Engineer', managerId: manager.id });
  const colleague = await makeEmployee({ number: 'AE-0004', first: 'Cal', last: 'Colleague', entityId: entityAe.id, jobTitle: 'Designer' });
  const hrKsa = await makeEmployee({ number: 'SA-0001', first: 'Hala', last: 'Hr', entityId: entitySa.id, jobTitle: 'HR Business Partner' });
  const ksaEmployee = await makeEmployee({ number: 'SA-0002', first: 'Sami', last: 'Saudi', entityId: entitySa.id, jobTitle: 'Analyst' });

  const accounts: [typeof admin, string, 'ADMIN' | 'HR_ADMIN' | 'MANAGER' | 'EMPLOYEE', string | null][] = [
    [admin, 'admin@test.demo', 'ADMIN', null],
    [hrKsa, 'hr.ksa@test.demo', 'HR_ADMIN', entitySa.id],
    [manager, 'manager@test.demo', 'MANAGER', null],
    [employee, 'employee@test.demo', 'EMPLOYEE', null],
    [colleague, 'colleague@test.demo', 'EMPLOYEE', null],
    [ksaEmployee, 'ksa.employee@test.demo', 'EMPLOYEE', null],
  ];

  for (const [person, email, role, scopedLegalEntityId] of accounts) {
    await prisma.user.create({
      data: { email, passwordHash, role, employeeId: person.id, scopedLegalEntityId },
    });
  }

  // Salaries exist so the compensation access rules have something to protect.
  for (const person of [employee, colleague, manager]) {
    await prisma.compensationRecord.create({
      data: {
        employeeId: person.id,
        effectiveFrom: date('2023-01-09'),
        baseSalary: new Prisma.Decimal(20000),
        currency: 'AED',
        changeReason: 'Starting compensation',
      },
    });
  }

  // This year's leave balances for the UAE employee under test.
  await prisma.leaveBalance.createMany({
    data: [
      { employeeId: employee.id, leaveTypeId: annualAe.id, year: 2026, entitledDays: new Prisma.Decimal(20) },
      { employeeId: employee.id, leaveTypeId: sickAe.id, year: 2026, entitledDays: new Prisma.Decimal(10) },
      { employeeId: colleague.id, leaveTypeId: annualAe.id, year: 2026, entitledDays: new Prisma.Decimal(20) },
      { employeeId: ksaEmployee.id, leaveTypeId: annualSa.id, year: 2026, entitledDays: new Prisma.Decimal(21) },
    ],
  });

  return {
    entityAe: entityAe.id,
    entitySa: entitySa.id,
    annualAe: annualAe.id,
    annualSa: annualSa.id,
    sickAe: sickAe.id,
    admin: admin.id,
    hrKsa: hrKsa.id,
    manager: manager.id,
    employee: employee.id,
    colleague: colleague.id,
    ksaEmployee: ksaEmployee.id,
    emails: {
      admin: 'admin@test.demo',
      hrKsa: 'hr.ksa@test.demo',
      manager: 'manager@test.demo',
      employee: 'employee@test.demo',
      colleague: 'colleague@test.demo',
      ksaEmployee: 'ksa.employee@test.demo',
    },
  };
}

/** Signs in and returns the access token. */
export async function login(email: string, password: string = TEST_PASSWORD): Promise<string> {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data.accessToken as string;
}

export function asUser(token: string) {
  return {
    get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => request(app).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => request(app).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
  };
}
