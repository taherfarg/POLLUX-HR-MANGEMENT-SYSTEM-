import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import { zonedDateKey } from '../src/services/timezone';

/**
 * Attendance and overtime through the API: self-service check-in/out, HR
 * records and corrections (always audited), overtime approval, and who may see
 * whose attendance. The calculation rules themselves are pinned down in
 * attendance-engine.test.ts with fixed instants; here the concern is wiring,
 * persistence and access.
 *
 * Fixture employees have no schedule assigned, so they follow the entity week:
 * Monday-Friday, 09:00-18:00 Dubai time, one-hour break.
 */
describe('attendance API', () => {
  let fixture: Fixture;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let colleagueToken: string;
  let hrKsaToken: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
    colleagueToken = await login(fixture.emails.colleague);
    hrKsaToken = await login(fixture.emails.hrKsa);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('self-service check-in and check-out', () => {
    it('checks the employee in and refuses a second check-in', async () => {
      const first = await asUser(employeeToken).post('/api/v1/attendance/check-in').send({});
      expect(first.status).toBe(201);
      expect(['PRESENT', 'LATE']).toContain(first.body.data.status);
      expect(first.body.data.isOpen).toBe(true);
      expect(first.body.data.timezone).toBe('Asia/Dubai');
      expect(first.body.data.checkIn).toBeTruthy();

      const second = await asUser(employeeToken).post('/api/v1/attendance/check-in').send({});
      expect(second.status).toBe(409);
    });

    it('offers a check-out, not a check-in, while checked in', async () => {
      const today = await asUser(employeeToken).get('/api/v1/attendance/today');
      expect(today.status).toBe(200);
      expect(today.body.data.canCheckIn).toBe(false);
      expect(today.body.data.canCheckOut).toBe(true);
      expect(today.body.data.timezone).toBe('Asia/Dubai');
      // Tracked from the hire date, not waiting for a company start date.
      expect(today.body.data.trackingStartsOn).toBeNull();
    });

    it('checks out once, and only once', async () => {
      const out = await asUser(employeeToken).post('/api/v1/attendance/check-out').send({ notes: 'Done for today' });
      expect(out.status).toBe(200);
      expect(out.body.data.checkOut).toBeTruthy();
      expect(out.body.data.isOpen).toBe(false);
      expect(out.body.data.notes).toBe('Done for today');

      const again = await asUser(employeeToken).post('/api/v1/attendance/check-out').send({});
      expect(again.status).toBe(409);
    });

    it('refuses a check-out without a check-in', async () => {
      const response = await asUser(colleagueToken).post('/api/v1/attendance/check-out').send({});
      expect(response.status).toBe(409);
    });
  });

  describe('HR records and corrections', () => {
    let recordId: string;

    it('records a day from local times and calculates lateness and overtime', async () => {
      // Monday 14 September 2026: 09:17 to 18:45 Dubai time.
      const response = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-14',
        checkIn: '09:17',
        checkOut: '18:45',
        reason: 'Forgot to check in',
      });
      expect(response.status).toBe(201);
      recordId = response.body.data.id;

      expect(response.body.data.checkIn).toBe('2026-09-14T05:17:00.000Z');
      expect(response.body.data.checkInLocal).toBe('09:17');
      expect(response.body.data.lateMinutes).toBe(17);
      expect(response.body.data.overtimeMinutes).toBe(45);
      expect(response.body.data.status).toBe('LATE');
      expect(response.body.data.isManual).toBe(true);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'AttendanceRecord', entityId: recordId } });
      expect(audit?.action).toBe('CREATE');
      expect(audit?.legalEntityId).toBe(fixture.entityAe);

      // Overtime is created from the attendance and waits for approval by default.
      const overtime = await prisma.overtimeEntry.findUnique({ where: { attendanceId: recordId } });
      expect(overtime?.minutes).toBe(45);
      expect(overtime?.status).toBe('PENDING');
      expect(Number(overtime?.rateMultiplier)).toBe(1.25);
    });

    it('refuses a second record for the same day', async () => {
      const response = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-14',
        checkIn: '09:00',
        reason: 'Duplicate',
      });
      expect(response.status).toBe(409);
    });

    it('corrects the record, re-evaluates it, audits the change and cancels the overtime', async () => {
      const response = await asUser(adminToken)
        .patch(`/api/v1/attendance/${recordId}`)
        .send({ checkOut: '18:00', reason: 'Badge reader recorded the wrong time' });
      expect(response.status).toBe(200);
      expect(response.body.data.overtimeMinutes).toBe(0);
      expect(response.body.data.lateMinutes).toBe(17);
      expect(response.body.data.correction.reason).toBe('Badge reader recorded the wrong time');

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'AttendanceRecord', entityId: recordId, action: 'UPDATE' },
      });
      expect(audit?.before).toMatchObject({ checkOut: '18:45', overtimeMinutes: 45 });
      expect(audit?.after).toMatchObject({ checkOut: '18:00', overtimeMinutes: 0 });

      const overtime = await prisma.overtimeEntry.findUnique({ where: { attendanceId: recordId } });
      expect(overtime?.status).toBe('CANCELLED');
    });

    it('requires a reason for every correction', async () => {
      const response = await asUser(adminToken).patch(`/api/v1/attendance/${recordId}`).send({ checkOut: '17:00' });
      expect(response.status).toBe(422);
    });

    it('lets HR set a status for a day without times', async () => {
      const response = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-15',
        status: 'PRESENT',
        reason: 'Full day at a client site',
      });
      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe('PRESENT');
      expect(response.body.data.statusOverridden).toBe(true);
    });

    it('rejects a check-out before the check-in and a date before the hire date', async () => {
      const reversed = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-16',
        checkIn: '18:00',
        checkOut: '09:00',
        reason: 'Reversed',
      });
      expect(reversed.status).toBe(422);

      const beforeHire = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2022-12-01',
        checkIn: '09:00',
        reason: 'Too early',
      });
      expect(beforeHire.status).toBe(422);
    });
  });

  describe('timezones', () => {
    it('evaluates a remote employee day in their own timezone', async () => {
      await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.colleague}`)
        .send({ workMode: 'REMOTE', workCity: 'Cairo', workCountry: 'Egypt', timezone: 'Africa/Cairo' });

      // Wednesday 16 September 2026, Cairo is UTC+3: 09:05 local is 06:05 UTC.
      const response = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-16',
        checkIn: '09:05',
        checkOut: '18:00',
        reason: 'Remote day entered by HR',
      });
      expect(response.status).toBe(201);
      expect(response.body.data.timezone).toBe('Africa/Cairo');
      expect(response.body.data.checkIn).toBe('2026-09-16T06:05:00.000Z');
      expect(response.body.data.scheduledStartLocal).toBe('09:00');
      expect(response.body.data.lateMinutes).toBe(0);

      // Earlier records keep the zone they were recorded in.
      const timesheet = await asUser(adminToken).get(
        `/api/v1/attendance/timesheet?employeeId=${fixture.colleague}&from=2026-09-14&to=2026-09-16`,
      );
      const byDate = Object.fromEntries(timesheet.body.data.days.map((day: { date: string; timezone: string }) => [day.date, day.timezone]));
      expect(byDate['2026-09-14']).toBe('Asia/Dubai');
      expect(byDate['2026-09-16']).toBe('Africa/Cairo');

      await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.colleague}`)
        .send({ workMode: 'ONSITE', workCity: null, workCountry: null, timezone: null });
    });
  });

  describe('timesheets', () => {
    it('shows every day of a range with totals, including evaluated absences and weekends', async () => {
      // 14-20 September: Mon (record), Tue (status), Wed (record), Thu+Fri (absent), Sat+Sun.
      const response = await asUser(adminToken).get(
        `/api/v1/attendance/timesheet?employeeId=${fixture.colleague}&from=2026-09-14&to=2026-09-20`,
      );
      expect(response.status).toBe(200);
      const statuses = response.body.data.days.map((day: { status: string }) => day.status);
      expect(statuses).toEqual(['LATE', 'PRESENT', 'PRESENT', 'ABSENT', 'ABSENT', 'WEEKEND', 'WEEKEND']);
      expect(response.body.data.totals.absentDays).toBe(2);
      expect(response.body.data.totals.lateDays).toBe(1);
      expect(response.body.data.totals.restDays).toBe(2);
      expect(response.body.data.days[3].isVirtual).toBe(true);
    });
  });

  describe('approved leave', () => {
    it('refuses a check-in on a day of approved leave', async () => {
      // Every day is a working day on this schedule, so the test does not
      // depend on which weekday it runs.
      const schedule = await asUser(adminToken).post('/api/v1/work-schedules').send({
        legalEntityId: fixture.entityAe,
        code: 'ALL-WEEK',
        name: 'All week',
        days: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, isWorkingDay: true, startTime: '00:00', endTime: '23:59' })),
      });
      expect(schedule.status).toBe(201);
      await asUser(adminToken).patch(`/api/v1/employees/${fixture.manager}`).send({ workScheduleId: schedule.body.data.id });

      const today = zonedDateKey(new Date(), 'Asia/Dubai');
      await prisma.request.create({
        data: {
          reference: 'LV-TEST-0001',
          type: 'LEAVE',
          status: 'APPROVED',
          employeeId: fixture.manager,
          legalEntityId: fixture.entityAe,
          leaveDetail: {
            create: {
              leaveTypeId: fixture.annualAe,
              startDate: new Date(`${today}T00:00:00.000Z`),
              endDate: new Date(`${today}T00:00:00.000Z`),
              workingDays: new Prisma.Decimal(1),
              reason: 'Day off',
            },
          },
        },
      });

      const response = await asUser(managerToken).post('/api/v1/attendance/check-in').send({});
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/approved Annual Leave/);

      const todayView = await asUser(managerToken).get('/api/v1/attendance/today');
      expect(todayView.body.data.today.status).toBe('ON_LEAVE');
      expect(todayView.body.data.canCheckIn).toBe(false);
    });
  });

  describe('overtime approval', () => {
    let entryId: string;

    it('creates pending overtime from a long day', async () => {
      const response = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.employee,
        date: '2026-09-17',
        checkIn: '09:00',
        checkOut: '19:30',
        reason: 'Release night',
      });
      expect(response.body.data.overtimeMinutes).toBe(90);
      const entry = await prisma.overtimeEntry.findUniqueOrThrow({ where: { attendanceId: response.body.data.id } });
      entryId = entry.id;
      expect(entry.status).toBe('PENDING');
    });

    it('does not let the employee or a colleague approve it', async () => {
      expect((await asUser(employeeToken).post(`/api/v1/overtime/${entryId}/approve`).send({})).status).toBe(403);
      expect((await asUser(colleagueToken).post(`/api/v1/overtime/${entryId}/approve`).send({})).status).toBe(403);
    });

    it('lets the direct manager approve minutes without seeing any amount', async () => {
      const approved = await asUser(managerToken).post(`/api/v1/overtime/${entryId}/approve`).send({ note: 'Thanks' });
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('APPROVED');
      expect(approved.body.data.hours).toBe(1.5);

      const list = await asUser(managerToken).get('/api/v1/overtime?myTeamOnly=true');
      expect(list.status).toBe(200);
      expect(list.body.data.every((entry: { employee: { id: string } }) => entry.employee.id === fixture.employee)).toBe(true);
    });

    it('refuses a second decision', async () => {
      const response = await asUser(adminToken).post(`/api/v1/overtime/${entryId}/reject`).send({ note: 'Too late' });
      expect(response.status).toBe(409);
    });

    it('lets HR record manual overtime, created approved', async () => {
      const response = await asUser(adminToken).post('/api/v1/overtime').send({
        employeeId: fixture.employee,
        date: '2026-09-19',
        minutes: 240,
        dayType: 'WEEKEND',
        reason: 'Saturday stock count',
      });
      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe('APPROVED');
      expect(response.body.data.rateMultiplier).toBe(1.5);

      const employee = await asUser(employeeToken).post('/api/v1/overtime').send({
        employeeId: fixture.employee,
        date: '2026-09-20',
        minutes: 600,
        reason: 'Self-awarded',
      });
      expect(employee.status).toBe(403);
    });
  });

  describe('who sees whose attendance', () => {
    it('keeps an employee to their own attendance', async () => {
      const list = await asUser(colleagueToken).get('/api/v1/attendance?from=2026-09-14&to=2026-09-20&includeRestDays=true');
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((row: { employee: { id: string } }) => row.employee.id === fixture.colleague)).toBe(true);

      const other = await asUser(colleagueToken).get(`/api/v1/attendance/timesheet?employeeId=${fixture.employee}`);
      expect(other.status).toBe(403);
    });

    it('does not let an employee create or change attendance', async () => {
      const create = await asUser(employeeToken).post('/api/v1/attendance').send({
        employeeId: fixture.colleague,
        date: '2026-09-18',
        checkIn: '09:00',
        reason: 'Covering for a friend',
      });
      expect(create.status).toBe(403);

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: fixture.colleague } });
      const change = await asUser(employeeToken).patch(`/api/v1/attendance/${record.id}`).send({ checkIn: '08:00', reason: 'x'.repeat(5) });
      expect(change.status).toBe(403);
    });

    it('lets a manager read a direct report but never correct it', async () => {
      const read = await asUser(managerToken).get(`/api/v1/attendance/timesheet?employeeId=${fixture.employee}&from=2026-09-14&to=2026-09-20`);
      expect(read.status).toBe(200);

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: fixture.employee } });
      const change = await asUser(managerToken).patch(`/api/v1/attendance/${record.id}`).send({ checkIn: '08:00', reason: 'Manager edit' });
      expect(change.status).toBe(403);
    });

    it('limits the board to managers and HR', async () => {
      expect((await asUser(colleagueToken).get('/api/v1/attendance/board')).status).toBe(403);

      const manager = await asUser(managerToken).get('/api/v1/attendance/board');
      expect(manager.status).toBe(200);
      expect(manager.body.data.rows.map((row: { employee: { id: string } }) => row.employee.id)).toEqual([fixture.employee]);

      const admin = await asUser(adminToken).get('/api/v1/attendance/board');
      expect(admin.status).toBe(200);
      expect(admin.body.data.counts.total).toBeGreaterThanOrEqual(6);
    });

    it('keeps a scoped HR admin inside their entity', async () => {
      const read = await asUser(hrKsaToken).get(`/api/v1/attendance/timesheet?employeeId=${fixture.employee}`);
      expect(read.status).toBe(403);

      const create = await asUser(hrKsaToken).post('/api/v1/attendance').send({
        employeeId: fixture.employee,
        date: '2026-09-18',
        checkIn: '09:00',
        reason: 'Out of scope',
      });
      expect(create.status).toBe(403);

      const board = await asUser(hrKsaToken).get('/api/v1/attendance/board');
      for (const row of board.body.data.rows) {
        expect([fixture.hrKsa, fixture.ksaEmployee]).toContain(row.employee.id);
      }
    });
  });
});
