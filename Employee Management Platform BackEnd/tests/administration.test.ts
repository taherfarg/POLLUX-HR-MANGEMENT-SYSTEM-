import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asUser, createFixture, login, resetDatabase, TEST_PASSWORD, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import { passwordSchema } from '../src/modules/auth/password';

/**
 * Users & Roles, leave balances across people, reports and the role-specific
 * dashboards - the administration surface, and above all who may use which
 * part of it.
 */

// Superagent types the response as its own Response; at runtime it is the Node stream.
const binary = (res: unknown, callback: (error: Error | null, body: Buffer) => void) => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

function download(token: string, url: string) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`).buffer(true).parse(binary);
}

describe('administration', () => {
  let fixture: Fixture;
  let adminToken: string;
  let hrKsaToken: string;
  let managerToken: string;
  let employeeToken: string;
  let newStarterId: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    hrKsaToken = await login(fixture.emails.hrKsa);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);

    const newStarter = await prisma.employee.create({
      data: {
        employeeNumber: 'AE-0009',
        firstName: 'Nia',
        lastName: 'New',
        workEmail: 'nia.new@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'Analyst',
        status: 'PROBATION',
        hireDate: new Date('2026-03-01T00:00:00.000Z'),
        dateOfBirth: new Date('1996-02-02T00:00:00.000Z'),
        gender: 'FEMALE',
      },
    });
    newStarterId = newStarter.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  describe('users and roles', () => {
    it('is closed to managers and employees', async () => {
      expect((await asUser(managerToken).get('/api/v1/users')).status).toBe(403);
      expect((await asUser(employeeToken).get('/api/v1/users')).status).toBe(403);
    });

    it('lists every login for an administrator, and only its entity for a scoped HR admin', async () => {
      const all = await asUser(adminToken).get('/api/v1/users');
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(6);
      expect(all.body.summary).toMatchObject({ ADMIN: 1, HR_ADMIN: 1, MANAGER: 1, EMPLOYEE: 3 });
      const me = all.body.data.find((user: { email: string }) => user.email === fixture.emails.admin);
      expect(me).toMatchObject({ isSelf: true, canManage: false });
      expect(me).not.toHaveProperty('passwordHash');

      const scoped = await asUser(hrKsaToken).get('/api/v1/users');
      expect(scoped.body.data.map((user: { email: string }) => user.email).sort()).toEqual([
        fixture.emails.hrKsa,
        fixture.emails.ksaEmployee,
      ]);
    });

    it('offers only employees without a login', async () => {
      const response = await asUser(adminToken).get('/api/v1/users/eligible-employees');
      expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([newStarterId]);
    });

    it('keeps a scoped HR admin from granting privileged roles or reaching another entity', async () => {
      const privileged = await asUser(hrKsaToken).post('/api/v1/users').send({ employeeId: newStarterId, role: 'ADMIN' });
      expect(privileged.status).toBe(403);
      const outOfScope = await asUser(hrKsaToken).post('/api/v1/users').send({ employeeId: newStarterId, role: 'EMPLOYEE' });
      expect(outOfScope.status).toBe(403);
    });

    it('creates a login with a one-time password that must be changed', async () => {
      const response = await asUser(adminToken).post('/api/v1/users').send({ employeeId: newStarterId, role: 'EMPLOYEE' });
      expect(response.status).toBe(201);
      const { user, temporaryPassword } = response.body.data;
      expect(user).toMatchObject({ email: 'nia.new@test.demo', role: 'EMPLOYEE', mustChangePassword: true, isActive: true });
      expect(passwordSchema.safeParse(temporaryPassword).success).toBe(true);

      const signIn = await request(app).post('/api/v1/auth/login').send({ email: 'nia.new@test.demo', password: temporaryPassword });
      expect(signIn.status).toBe(200);
      expect(signIn.body.data.user.mustChangePassword).toBe(true);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: user.id, action: 'CREATE' } });
      expect(JSON.stringify(audit)).not.toContain(temporaryPassword);

      const again = await asUser(adminToken).post('/api/v1/users').send({ employeeId: newStarterId, role: 'EMPLOYEE' });
      expect(again.status).toBe(409);
    });

    it('never lets an HR admin reset an administrator\'s password', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.admin } });
      const response = await asUser(hrKsaToken).post(`/api/v1/users/${admin.id}/reset-password`).send({});
      expect(response.status).toBe(403);
    });

    it('resets a password in scope, ending the old one', async () => {
      const target = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.ksaEmployee } });
      const response = await asUser(hrKsaToken).post(`/api/v1/users/${target.id}/reset-password`).send({});
      expect(response.status).toBe(200);
      const temporaryPassword = response.body.data.temporaryPassword as string;

      const old = await request(app).post('/api/v1/auth/login').send({ email: fixture.emails.ksaEmployee, password: TEST_PASSWORD });
      expect(old.status).toBe(401);
      const fresh = await request(app).post('/api/v1/auth/login').send({ email: fixture.emails.ksaEmployee, password: temporaryPassword });
      expect(fresh.status).toBe(200);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: target.id, action: 'PASSWORD_CHANGE' } });
      expect(audit?.legalEntityId).toBe(fixture.entitySa);
      expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
    });

    it('refuses changes to your own account', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.admin } });
      expect((await asUser(adminToken).patch(`/api/v1/users/${admin.id}`).send({ role: 'EMPLOYEE' })).status).toBe(403);
      expect((await asUser(adminToken).patch(`/api/v1/users/${admin.id}`).send({ isActive: false })).status).toBe(403);
    });

    it('deactivating a login ends its sessions at once', async () => {
      const manager = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.manager } });
      const deactivated = await asUser(adminToken).patch(`/api/v1/users/${manager.id}`).send({ isActive: false });
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.data.isActive).toBe(false);
      expect((await asUser(managerToken).get('/api/v1/me/profile')).status).toBe(401);
      expect(await prisma.refreshToken.count({ where: { userId: manager.id, revokedAt: null } })).toBe(0);

      const reactivated = await asUser(adminToken).patch(`/api/v1/users/${manager.id}`).send({ isActive: true });
      expect(reactivated.body.data.isActive).toBe(true);
      managerToken = await login(fixture.emails.manager);
    });

    it('changes a role and records it', async () => {
      const colleague = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.colleague } });
      const promoted = await asUser(adminToken).patch(`/api/v1/users/${colleague.id}`).send({ role: 'MANAGER' });
      expect(promoted.status).toBe(200);
      expect(promoted.body.data.role).toBe('MANAGER');
      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: colleague.id, action: 'UPDATE' } });
      expect(audit?.before).toMatchObject({ role: 'EMPLOYEE' });
      expect(audit?.after).toMatchObject({ role: 'MANAGER' });
      await asUser(adminToken).patch(`/api/v1/users/${colleague.id}`).send({ role: 'EMPLOYEE' });
    });

    it('unlocks a locked account', async () => {
      const employee = await prisma.user.update({
        where: { email: fixture.emails.employee },
        data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });
      const response = await asUser(adminToken).post(`/api/v1/users/${employee.id}/unlock`);
      expect(response.status).toBe(200);
      expect(response.body.data.isLocked).toBe(false);
      expect(response.body.data.failedLoginAttempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('leave balances', () => {
    it('shows each role the balances it may see', async () => {
      const own = await asUser(employeeToken).get('/api/v1/leave/balances?year=2026');
      expect(own.status).toBe(200);
      expect(new Set(own.body.data.map((row: { employee: { id: string } }) => row.employee.id))).toEqual(new Set([fixture.employee]));

      const team = await asUser(managerToken).get('/api/v1/leave/balances?year=2026');
      expect(team.body.data.map((row: { employee: { id: string } }) => row.employee.id)).toContain(fixture.employee);
      expect(team.body.data.map((row: { employee: { id: string } }) => row.employee.id)).not.toContain(fixture.colleague);

      const scoped = await asUser(hrKsaToken).get('/api/v1/leave/balances?year=2026');
      expect(scoped.body.data.map((row: { employee: { id: string } }) => row.employee.id)).toEqual([fixture.ksaEmployee]);

      const all = await asUser(adminToken).get('/api/v1/leave/balances?year=2026');
      expect(all.body.meta.total).toBe(4);
      expect(all.body.totals.entitledDays).toBe(71);
    });

    it('lets HR adjust a balance with a reason, never below what is taken', async () => {
      const balance = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: fixture.employee, leaveTypeId: fixture.annualAe, year: 2026 } });
      await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: 5 } });

      expect((await asUser(employeeToken).patch(`/api/v1/leave/balances/${balance.id}`).send({ entitledDays: 30, reason: 'Please' })).status).toBe(403);
      expect((await asUser(hrKsaToken).patch(`/api/v1/leave/balances/${balance.id}`).send({ entitledDays: 30, reason: 'Other entity' })).status).toBe(403);

      const tooLow = await asUser(adminToken).patch(`/api/v1/leave/balances/${balance.id}`).send({ entitledDays: 3, reason: 'Correction' });
      expect(tooLow.status).toBe(422);

      const adjusted = await asUser(adminToken)
        .patch(`/api/v1/leave/balances/${balance.id}`)
        .send({ entitledDays: 22, carriedOverDays: 1.5, reason: 'Two extra days agreed at hiring' });
      expect(adjusted.status).toBe(200);
      expect(adjusted.body.data).toMatchObject({ entitledDays: 22, carriedOverDays: 1.5, usedDays: 5, availableDays: 18.5 });

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'LeaveBalance', entityId: balance.id } });
      expect(audit?.summary).toContain('Two extra days agreed at hiring');
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('generates next year\'s balances with carry-over, once', async () => {
      await prisma.leaveType.update({ where: { id: fixture.annualAe }, data: { carryOverMaxDays: 5 } });

      expect((await asUser(hrKsaToken).post('/api/v1/leave/balances/generate').send({ year: 2027, legalEntityId: fixture.entityAe })).status).toBe(403);

      const first = await asUser(adminToken).post('/api/v1/leave/balances/generate').send({ year: 2027, legalEntityId: fixture.entityAe });
      expect(first.status).toBe(200);
      expect(first.body.data.created).toBeGreaterThan(0);

      const annual = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: fixture.employee, leaveTypeId: fixture.annualAe, year: 2027 } });
      // 18.5 days unused in 2026, capped at the 5-day carry-over limit.
      expect(annual.carriedOverDays.toString()).toBe('5');
      expect(annual.entitledDays.toString()).toBe('20');

      const second = await asUser(adminToken).post('/api/v1/leave/balances/generate').send({ year: 2027, legalEntityId: fixture.entityAe });
      expect(second.body.data.created).toBe(0);
      expect(second.body.data.skipped).toBe(first.body.data.created);
    });
  });

  // ---------------------------------------------------------------------------
  describe('reports', () => {
    it('is closed to employees', async () => {
      expect((await asUser(employeeToken).get('/api/v1/reports')).status).toBe(403);
      expect((await asUser(employeeToken).get('/api/v1/reports/attendance')).status).toBe(403);
    });

    it('offers managers the team reports only, limited to their team', async () => {
      const catalog = await asUser(managerToken).get('/api/v1/reports');
      expect(catalog.status).toBe(200);
      const types = catalog.body.data.map((report: { type: string }) => report.type);
      expect(types).toEqual(['attendance', 'late', 'absence', 'overtime', 'leave', 'leave-balance']);

      for (const type of ['payroll', 'advances', 'employees']) {
        expect((await asUser(managerToken).get(`/api/v1/reports/${type}`)).status).toBe(403);
      }

      const attendance = await asUser(managerToken).get('/api/v1/reports/attendance?from=2026-09-01&to=2026-09-10');
      expect(attendance.status).toBe(200);
      expect(attendance.body.data.teamOnly).toBe(true);
      expect(attendance.body.data.rows.map((row: { employeeNumber: string }) => row.employeeNumber).sort()).toEqual(['AE-0002', 'AE-0003']);
    });

    it('rejects an unknown report', async () => {
      expect((await asUser(adminToken).get('/api/v1/reports/salaries')).status).toBe(422);
    });

    it('exports CSV with a byte-order mark and neutralised formulas, and audits the export', async () => {
      await prisma.employee.update({ where: { id: fixture.colleague }, data: { firstName: '=2+3' } });
      try {
        const response = await download(adminToken, '/api/v1/reports/employees?format=csv');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/csv');
        expect(response.headers['content-disposition']).toMatch(/^attachment; filename="pollux-employees-report-\d{4}-\d{2}-\d{2}\.csv"$/);
        const text = (response.body as Buffer).toString('utf8');
        expect(text.charCodeAt(0)).toBe(0xfeff);
        expect(text).toContain("'=2+3 Colleague");
        expect(text).not.toMatch(/(^|,)=2\+3/m);
        // The employee report never carries pay.
        expect(text).not.toContain('20000');
      } finally {
        await prisma.employee.update({ where: { id: fixture.colleague }, data: { firstName: 'Cal' } });
      }

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Report', entityId: 'employees', action: 'EXPORT' } });
      expect(audit).not.toBeNull();
    });

    it('exports Excel and PDF files', async () => {
      const xlsx = await download(adminToken, '/api/v1/reports/attendance?from=2026-09-01&to=2026-09-10&format=xlsx');
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      const pdf = await download(adminToken, '/api/v1/reports/leave-balance?year=2026&format=pdf');
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('audits even viewing a pay report', async () => {
      const response = await asUser(adminToken).get('/api/v1/reports/payroll');
      expect(response.status).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Report', entityId: 'payroll', action: 'VIEW_SENSITIVE' } });
      expect(audit).not.toBeNull();
    });

    it('keeps a scoped HR admin inside their entity', async () => {
      const response = await asUser(hrKsaToken).get('/api/v1/reports/employees');
      expect(response.body.data.rows.map((row: { employeeNumber: string }) => row.employeeNumber).sort()).toEqual(['SA-0001', 'SA-0002']);
    });
  });

  // ---------------------------------------------------------------------------
  describe('document library', () => {
    beforeAll(async () => {
      const soon = new Date(Date.now() + 30 * 86_400_000);
      await prisma.document.createMany({
        data: [
          { employeeId: fixture.employee, category: 'VISA_PERMIT', title: 'Residence visa', fileName: 'visa.pdf', fileUrl: 'https://files.test/visa.pdf', expiresOn: soon },
          { employeeId: fixture.employee, category: 'OTHER', title: 'Disciplinary note', fileName: 'note.pdf', fileUrl: 'https://files.test/note.pdf', isConfidential: true },
          { employeeId: fixture.ksaEmployee, category: 'CONTRACT', title: 'KSA contract', fileName: 'contract.pdf', fileUrl: 'https://files.test/contract.pdf' },
        ],
      });
    });

    it('shows an employee their own documents without the confidential ones', async () => {
      const response = await asUser(employeeToken).get('/api/v1/documents');
      expect(response.status).toBe(200);
      expect(response.body.data.map((document: { title: string }) => document.title)).toEqual(['Residence visa']);
      // A filter for someone else changes nothing.
      const other = await asUser(employeeToken).get(`/api/v1/documents?employeeId=${fixture.ksaEmployee}`);
      expect(other.body.data.map((document: { title: string }) => document.title)).toEqual(['Residence visa']);
    });

    it('gives a manager nothing of their team\'s documents', async () => {
      const response = await asUser(managerToken).get('/api/v1/documents');
      expect(response.body.data).toEqual([]);
    });

    it('gives HR the library in scope with expiry counts', async () => {
      const all = await asUser(adminToken).get('/api/v1/documents');
      expect(all.body.meta.total).toBe(3);
      expect(all.body.summary.expiringSoon).toBe(1);

      const expiring = await asUser(adminToken).get('/api/v1/documents?expiring=true');
      expect(expiring.body.data.map((document: { title: string }) => document.title)).toEqual(['Residence visa']);

      const scoped = await asUser(hrKsaToken).get('/api/v1/documents');
      expect(scoped.body.data.map((document: { title: string }) => document.title)).toEqual(['KSA contract']);
    });
  });

  // ---------------------------------------------------------------------------
  describe('dashboards', () => {
    it('gives HR the company view with payroll', async () => {
      const response = await asUser(adminToken).get('/api/v1/dashboard');
      expect(response.status).toBe(200);
      const data = response.body.data;
      expect(data.view).toBe('MANAGEMENT');
      // Six fixture employees in both entities plus the new starter.
      expect(data.cards).toMatchObject({ totalEmployees: 7, remoteEmployees: 0, pendingLeaveRequests: 0, pendingSalaryAdvances: 0 });
      expect(data.payroll).toBeDefined();
      expect(Array.isArray(data.recentActivity)).toBe(true);
      expect(data.pendingApprovals.counts).toBeDefined();
    });

    it('gives a manager their team, without anyone\'s pay', async () => {
      const response = await asUser(managerToken).get('/api/v1/dashboard');
      const data = response.body.data;
      expect(data.view).toBe('MANAGER');
      expect(data.team.teamSize).toBe(1);
      expect(data.team.cards).toBeDefined();
      expect(data).not.toHaveProperty('payroll');
      expect(JSON.stringify(data.team)).not.toMatch(/netSalary|baseSalary|amount/);
    });

    it('gives an employee their own panels only', async () => {
      const response = await asUser(employeeToken).get('/api/v1/dashboard');
      const data = response.body.data;
      expect(data.view).toBe('EMPLOYEE');
      expect(data.team).toBeNull();
      expect(data).not.toHaveProperty('payroll');
      expect(data).not.toHaveProperty('cards');
      expect(data.attendanceToday.timezone).toBe('Asia/Dubai');
      expect(data.pay).toEqual({ latestPayslip: null, activeAdvance: null });
    });

    it('scopes the company view for an entity HR admin', async () => {
      const response = await asUser(hrKsaToken).get('/api/v1/dashboard');
      expect(response.body.data.cards.totalEmployees).toBe(2);
    });
  });
});
