import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';

/**
 * Pollux organisation structure: company settings, work locations, work
 * schedules and holiday calendars - and the way they change leave arithmetic -
 * plus the three access-control fixes found in the Phase 0 audit.
 */
describe('Pollux organisation structure', () => {
  let fixture: Fixture;
  let adminToken: string;
  let hrKsaToken: string;
  let managerToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    hrKsaToken = await login(fixture.emails.hrKsa);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('company settings', () => {
    it('gives everyone the public subset and only management the policy', async () => {
      const employee = await asUser(employeeToken).get('/api/v1/settings/company');
      expect(employee.status).toBe(200);
      expect(employee.body.data.company.currency).toBe('AED');
      expect(employee.body.data).not.toHaveProperty('attendance');
      expect(employee.body.data).not.toHaveProperty('overtime');

      const admin = await asUser(adminToken).get('/api/v1/settings/company');
      expect(admin.status).toBe(200);
      expect(admin.body.data.attendance.lateGraceMinutes).toBe(10);
      expect(admin.body.data.payroll.salaryDayBasis).toBe('FIXED_30');
    });

    it('lets only an administrator change policy, and audits the change', async () => {
      const hr = await asUser(hrKsaToken)
        .patch(`/api/v1/settings/company?legalEntityId=${fixture.entitySa}`)
        .send({ attendance: { lateGraceMinutes: 30 } });
      expect(hr.status).toBe(403);

      const employee = await asUser(employeeToken).patch('/api/v1/settings/company').send({ attendance: { lateGraceMinutes: 30 } });
      expect(employee.status).toBe(403);

      const admin = await asUser(adminToken)
        .patch(`/api/v1/settings/company?legalEntityId=${fixture.entityAe}`)
        .send({ attendance: { lateGraceMinutes: 15 }, overtime: { overtimeRateMultiplier: 1.5 } });
      expect(admin.status).toBe(200);
      expect(admin.body.data.attendance.lateGraceMinutes).toBe(15);
      expect(admin.body.data.overtime.overtimeRateMultiplier).toBe(1.5);

      const entry = await prisma.auditLog.findFirst({ where: { entityType: 'CompanySettings', legalEntityId: fixture.entityAe } });
      expect(entry).not.toBeNull();
      expect(entry?.before).toMatchObject({ attendance: { lateGraceMinutes: 10 } });
      expect(entry?.after).toMatchObject({ attendance: { lateGraceMinutes: 15 } });
    });

    it('rejects an unknown timezone', async () => {
      const response = await asUser(adminToken)
        .patch(`/api/v1/settings/company?legalEntityId=${fixture.entityAe}`)
        .send({ company: { timezone: 'Mars/Olympus_Mons' } });
      expect(response.status).toBe(422);
    });

    it('serves login branding without authentication', async () => {
      const response = await request(app).get('/api/v1/public/branding');
      expect(response.status).toBe(200);
      expect(response.body.data.productName).toBe('Pollux HR');
      expect(response.body.data).not.toHaveProperty('attendance');
    });
  });

  describe('work locations', () => {
    it('lets HR create a location and blocks an employee from doing so', async () => {
      const blocked = await asUser(employeeToken)
        .post('/api/v1/work-locations')
        .send({ code: 'HACK', name: 'Hack', kind: 'OFFICE' });
      expect(blocked.status).toBe(403);

      const created = await asUser(adminToken).post('/api/v1/work-locations').send({
        legalEntityId: fixture.entityAe,
        code: 'dubai office',
        name: 'Dubai Office',
        kind: 'OFFICE',
        city: 'Dubai',
        countryCode: 'AE',
        countryName: 'United Arab Emirates',
        timezone: 'Asia/Dubai',
      });
      expect(created.status).toBe(201);
      expect(created.body.data.code).toBe('DUBAI-OFFICE');

      const list = await asUser(employeeToken).get('/api/v1/work-locations');
      expect(list.body.data.map((location: { name: string }) => location.name)).toContain('Dubai Office');
    });
  });

  describe('work schedules and employee-aware leave', () => {
    let partTimeId: string;

    it('rejects a working day that ends before it starts', async () => {
      const response = await asUser(adminToken).post('/api/v1/work-schedules').send({
        legalEntityId: fixture.entityAe,
        code: 'BROKEN',
        name: 'Broken',
        days: [{ dayOfWeek: 1, isWorkingDay: true, startTime: '18:00', endTime: '09:00' }],
      });
      expect(response.status).toBe(422);
    });

    it('creates a part-time schedule and reports its weekly minutes', async () => {
      const response = await asUser(adminToken).post('/api/v1/work-schedules').send({
        legalEntityId: fixture.entityAe,
        code: 'part time mwf',
        name: 'Part-time Mon/Wed/Fri',
        days: [
          { dayOfWeek: 1, isWorkingDay: true, startTime: '09:00', endTime: '13:00' },
          { dayOfWeek: 3, isWorkingDay: true, startTime: '09:00', endTime: '13:00' },
          { dayOfWeek: 5, isWorkingDay: true, startTime: '09:00', endTime: '13:00' },
        ],
      });
      expect(response.status).toBe(201);
      expect(response.body.data.workingDays).toEqual([1, 3, 5]);
      expect(response.body.data.weeklyMinutes).toBe(12 * 60);
      expect(response.body.data.timezoneMode).toBe('EMPLOYEE_LOCAL');
      partTimeId = response.body.data.id;
    });

    it('charges leave only on the employee own working days', async () => {
      // Mon 9 - Fri 13 Nov 2026: five weekdays, no holidays in range.
      const before = await asUser(employeeToken)
        .post('/api/v1/requests/leave/preview')
        .send({ startDate: '2026-11-09', endDate: '2026-11-13' });
      expect(before.body.data.workingDays).toBe(5);

      const assigned = await asUser(adminToken)
        .post(`/api/v1/work-schedules/${partTimeId}/assign`)
        .send({ employeeIds: [fixture.employee] });
      expect(assigned.status).toBe(200);
      expect(assigned.body.data.assigned).toBe(1);

      const after = await asUser(employeeToken)
        .post('/api/v1/requests/leave/preview')
        .send({ startDate: '2026-11-09', endDate: '2026-11-13' });
      expect(after.body.data.workingDays).toBe(3);

      // Back to the company default for the rest of the suite.
      await asUser(adminToken).patch(`/api/v1/employees/${fixture.employee}`).send({ workScheduleId: null });
    });

    it('refuses to assign a schedule from another company', async () => {
      const response = await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.ksaEmployee}`)
        .send({ workScheduleId: partTimeId });
      expect(response.status).toBe(422);
      expect(response.body.error.details).toHaveProperty('workScheduleId');
    });
  });

  describe('holiday calendars', () => {
    let egyptCalendarId: string;

    it('creates a second calendar and adds a holiday to it', async () => {
      const calendar = await asUser(adminToken).post('/api/v1/holiday-calendars').send({
        legalEntityId: fixture.entityAe,
        code: 'EG-HOLIDAYS',
        name: 'Egypt Public Holidays',
        countryCode: 'EG',
      });
      expect(calendar.status).toBe(201);
      egyptCalendarId = calendar.body.data.id;

      // Tuesday 10 Nov 2026, only in the Egypt calendar.
      const holiday = await asUser(adminToken)
        .post('/api/v1/leave/holidays')
        .send({ calendarId: egyptCalendarId, name: 'Test Egypt Holiday', date: '2026-11-10' });
      expect(holiday.status).toBe(201);
      expect(holiday.body.data.calendar.id).toBe(egyptCalendarId);
    });

    it('lets two calendars in one company share a date', async () => {
      // 4 Nov is already a holiday in the UAE test calendar.
      const response = await asUser(adminToken)
        .post('/api/v1/leave/holidays')
        .send({ calendarId: egyptCalendarId, name: 'Same Day Elsewhere', date: '2026-11-04' });
      expect(response.status).toBe(201);
    });

    it('applies the calendar the employee is assigned, not the one they live near', async () => {
      // Mon 2 - Fri 13 Nov 2026 covers the UAE holiday (4th) and the Egypt-only one (10th).
      const range = { startDate: '2026-11-02', endDate: '2026-11-13' };

      const defaultCalendar = await asUser(employeeToken).post('/api/v1/requests/leave/preview').send(range);
      expect(defaultCalendar.body.data.workingDays).toBe(9);
      expect(defaultCalendar.body.data.holidaysInRange.map((h: { name: string }) => h.name)).toEqual(['Test Holiday']);

      await asUser(adminToken).patch(`/api/v1/employees/${fixture.employee}`).send({ holidayCalendarId: egyptCalendarId });

      const egyptCalendar = await asUser(employeeToken).post('/api/v1/requests/leave/preview').send(range);
      expect(egyptCalendar.body.data.holidaysInRange.map((h: { name: string }) => h.name)).toEqual([
        'Same Day Elsewhere',
        'Test Egypt Holiday',
      ]);
      expect(egyptCalendar.body.data.workingDays).toBe(8);

      await asUser(adminToken).patch(`/api/v1/employees/${fixture.employee}`).send({ holidayCalendarId: null });
    });

    it('repeats a recurring holiday every year', async () => {
      // Entered once, dated 2025, marked recurring.
      await asUser(adminToken)
        .post('/api/v1/leave/holidays')
        .send({ legalEntityId: fixture.entityAe, name: 'National Day', date: '2025-12-02', isRecurringAnnually: true });

      // Tue 1 - Fri 4 Dec 2026.
      const preview = await asUser(employeeToken)
        .post('/api/v1/requests/leave/preview')
        .send({ startDate: '2026-12-01', endDate: '2026-12-04' });
      expect(preview.body.data.workingDays).toBe(3);
      expect(preview.body.data.holidaysInRange).toEqual([{ date: '2026-12-02', name: 'National Day' }]);
    });

    it('edits a holiday and records the change', async () => {
      const list = await asUser(adminToken).get(`/api/v1/leave/holidays?calendarId=${egyptCalendarId}`);
      const target = list.body.data.find((holiday: { name: string }) => holiday.name === 'Test Egypt Holiday');

      const updated = await asUser(adminToken)
        .patch(`/api/v1/leave/holidays/${target.id}`)
        .send({ name: 'Renamed Egypt Holiday', type: 'COMPANY' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.name).toBe('Renamed Egypt Holiday');
      expect(updated.body.data.type).toBe('COMPANY');

      const employee = await asUser(employeeToken).patch(`/api/v1/leave/holidays/${target.id}`).send({ name: 'Nope' });
      expect(employee.status).toBe(403);
    });
  });

  describe('employee work context', () => {
    it('stores a remote arrangement and rejects an unknown timezone', async () => {
      const invalid = await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.colleague}`)
        .send({ timezone: 'Nowhere/Place' });
      expect(invalid.status).toBe(422);

      const updated = await asUser(adminToken).patch(`/api/v1/employees/${fixture.colleague}`).send({
        workMode: 'REMOTE',
        workCountryCode: 'EG',
        workCountry: 'Egypt',
        workCity: 'Cairo',
        timezone: 'Africa/Cairo',
      });
      expect(updated.status).toBe(200);
      expect(updated.body.data.workMode).toBe('REMOTE');
      expect(updated.body.data.effectiveTimezone).toBe('Africa/Cairo');

      const timeline = await asUser(adminToken).get(`/api/v1/employees/${fixture.colleague}/timeline`);
      expect(timeline.body.data.map((entry: { title: string }) => entry.title)).toContain(
        'Work arrangement changed to remote (Cairo)',
      );
    });

    it('keeps a remote colleague city out of the address book', async () => {
      const colleagueView = await asUser(employeeToken).get(`/api/v1/employees/${fixture.colleague}`);
      expect(colleagueView.body.data.viewLevel).toBe('DIRECTORY');
      expect(colleagueView.body.data.workMode).toBe('REMOTE');
      expect(colleagueView.body.data).not.toHaveProperty('workCity');
      expect(colleagueView.body.data).not.toHaveProperty('timezone');
    });

    it('returns capabilities that match the privacy rules', async () => {
      const manager = await asUser(managerToken).get(`/api/v1/employees/${fixture.employee}`);
      expect(manager.body.data.capabilities).toMatchObject({
        canViewAttendance: true,
        canViewCompensation: false,
        canViewPayData: false,
        canEdit: false,
      });

      const self = await asUser(employeeToken).get(`/api/v1/employees/${fixture.employee}`);
      expect(self.body.data.capabilities).toMatchObject({ canViewPayData: true, canManageAttendance: false });
    });
  });

  describe('access-control fixes from the audit', () => {
    it('stops an HR admin from minting an ADMIN or HR_ADMIN login', async () => {
      const base = {
        firstName: 'Esc',
        jobTitle: 'Analyst',
        hireDate: '2026-09-01',
        legalEntityId: fixture.entitySa,
      };

      const admin = await asUser(hrKsaToken)
        .post('/api/v1/employees')
        .send({ ...base, lastName: 'Admin', workEmail: 'esc.admin@test.demo', account: { role: 'ADMIN' } });
      expect(admin.status).toBe(403);

      const hr = await asUser(hrKsaToken)
        .post('/api/v1/employees')
        .send({ ...base, lastName: 'Hr', workEmail: 'esc.hr@test.demo', account: { role: 'HR_ADMIN' } });
      expect(hr.status).toBe(403);

      // Nothing was written by the refused attempts.
      expect(await prisma.employee.count({ where: { workEmail: { startsWith: 'esc.' } } })).toBe(0);

      const employee = await asUser(hrKsaToken)
        .post('/api/v1/employees')
        .send({ ...base, lastName: 'Employee', workEmail: 'esc.employee@test.demo', account: { role: 'EMPLOYEE' } });
      expect(employee.status).toBe(201);
    });

    it('still lets a global administrator create an HR admin', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'New',
        lastName: 'Hr',
        workEmail: 'new.hr@test.demo',
        jobTitle: 'HR Officer',
        hireDate: '2026-09-01',
        legalEntityId: fixture.entityAe,
        account: { role: 'HR_ADMIN' },
      });
      expect(response.status).toBe(201);
      expect(response.body.data.employee.account.role).toBe('HR_ADMIN');
    });

    it('limits a scoped HR admin audit trail to their own entity', async () => {
      // A UAE salary read by the admin writes a UAE-tagged entry.
      await asUser(adminToken).get(`/api/v1/employees/${fixture.employee}/compensation`);

      const scoped = await asUser(hrKsaToken).get('/api/v1/audit-logs?pageSize=100');
      expect(scoped.status).toBe(200);
      for (const entry of scoped.body.data) {
        expect(entry.legalEntityId).toBe(fixture.entitySa);
      }

      const global = await asUser(adminToken).get('/api/v1/audit-logs?pageSize=100');
      expect(global.body.data.some((entry: { legalEntityId: string }) => entry.legalEntityId === fixture.entityAe)).toBe(true);
    });

    it('stops a scoped HR admin cancelling another entity request', async () => {
      const submitted = await asUser(employeeToken)
        .post('/api/v1/requests/leave')
        .send({ leaveTypeId: fixture.annualAe, startDate: '2026-11-16', endDate: '2026-11-16', reason: 'Scope probe' });
      expect(submitted.status).toBe(201);

      const scoped = await asUser(hrKsaToken).post(`/api/v1/requests/${submitted.body.data.id}/cancel`).send({});
      expect(scoped.status).toBe(403);

      const admin = await asUser(adminToken).post(`/api/v1/requests/${submitted.body.data.id}/cancel`).send({});
      expect(admin.status).toBe(200);
      expect(admin.body.data.status).toBe('CANCELLED');
    });
  });
});
