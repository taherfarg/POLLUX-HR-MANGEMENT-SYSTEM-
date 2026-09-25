import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';

describe('employee management', () => {
  let fixture: Fixture;
  let adminToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    employeeToken = await login(fixture.emails.employee);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('creating an employee', () => {
    it('creates the record, the timeline entry, a salary and a working login', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'New', lastName: 'Starter',
        workEmail: 'new.starter@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'Junior Engineer',
        hireDate: '2026-09-01',
        gender: 'UNDISCLOSED',
        compensation: { baseSalary: 12000, changeReason: 'Starting compensation' },
        account: { role: 'EMPLOYEE' },
      });

      expect(response.status).toBe(201);
      const created = response.body.data.employee;
      expect(created.employeeNumber).toMatch(/^AE-\d{4}$/);
      expect(created.status).toBe('PROBATION');

      // The temporary password is returned once and never stored in the clear.
      const temporaryPassword = response.body.data.temporaryPassword as string;
      expect(temporaryPassword).toBeTruthy();
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new.starter@test.demo' } });
      expect(user.passwordHash).not.toContain(temporaryPassword);
      expect(user.mustChangePassword).toBe(true);

      // That password actually works.
      const token = await login('new.starter@test.demo', temporaryPassword);
      expect(token).toBeTruthy();

      const events = await prisma.employmentEvent.findMany({ where: { employeeId: created.id } });
      expect(events.map((event) => event.type)).toContain('HIRED');

      const compensation = await prisma.compensationRecord.findFirstOrThrow({ where: { employeeId: created.id } });
      expect(Number(compensation.baseSalary)).toBe(12000);
      // Currency defaults to the legal entity currency rather than a global default.
      expect(compensation.currency).toBe('AED');

      // Leave balances are seeded from the entity policy, pro-rated for a
      // September start: 20 days x 4/12 remaining months.
      const balances = await prisma.leaveBalance.findMany({ where: { employeeId: created.id } });
      expect(balances.length).toBeGreaterThan(0);
      const annual = balances.find((balance) => balance.leaveTypeId === fixture.annualAe);
      expect(Number(annual?.entitledDays)).toBe(6.5);
    });

    it('derives the probation end date from the legal entity policy', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'Probation', lastName: 'Check',
        workEmail: 'probation.check@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'Analyst',
        hireDate: '2026-09-01',
      });

      // The test UAE entity uses the six-month schema default.
      expect(response.body.data.employee.probationEndDate).toBe('2027-03-01');
    });

    it('refuses a duplicate work email', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'Duplicate', lastName: 'Email',
        workEmail: 'new.starter@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'Engineer',
        hireDate: '2026-09-01',
      });

      expect(response.status).toBe(409);
    });

    it('refuses an unknown legal entity', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'Ghost', lastName: 'Entity',
        workEmail: 'ghost.entity@test.demo',
        legalEntityId: 'does-not-exist',
        jobTitle: 'Engineer',
        hireDate: '2026-09-01',
      });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toHaveProperty('legalEntityId');
    });

    it('requires an end date on a limited contract', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'Limited', lastName: 'Contract',
        workEmail: 'limited.contract@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'Consultant',
        hireDate: '2026-09-01',
        contractType: 'LIMITED',
      });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toHaveProperty('contractEndDate');
    });

    it('rejects a missing required field with a field-level message', async () => {
      const response = await asUser(adminToken)
        .post('/api/v1/employees')
        .send({ firstName: 'No', lastName: 'Entity', workEmail: 'no.entity@test.demo' });

      expect(response.status).toBe(422);
      // legalEntityId is no longer required (Pollux resolves the company
      // automatically); the genuinely required employment fields still are.
      expect(Object.keys(response.body.error.details)).toEqual(expect.arrayContaining(['jobTitle', 'hireDate']));
      expect(response.body.error.details).not.toHaveProperty('legalEntityId');
    });

    it('places a new employee in the primary company when no legal entity is given', async () => {
      const response = await asUser(adminToken).post('/api/v1/employees').send({
        firstName: 'Default', lastName: 'Company',
        workEmail: 'default.company@test.demo',
        jobTitle: 'Coordinator',
        hireDate: '2026-09-01',
      });

      expect(response.status).toBe(201);
      // With no settings row flagged primary, the oldest active entity is the company.
      const oldest = await prisma.legalEntity.findFirstOrThrow({ orderBy: [{ establishedOn: 'asc' }, { createdAt: 'asc' }] });
      expect(response.body.data.employee.legalEntity.id).toBe(oldest.id);
    });
  });

  describe('updating an employee', () => {
    it('persists the change, writes a timeline event and an audit entry', async () => {
      const response = await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.employee}`)
        .send({ jobTitle: 'Senior Engineer' });

      expect(response.status).toBe(200);
      expect(response.body.data.jobTitle).toBe('Senior Engineer');

      const stored = await prisma.employee.findUniqueOrThrow({ where: { id: fixture.employee } });
      expect(stored.jobTitle).toBe('Senior Engineer');

      const promotion = await prisma.employmentEvent.findFirst({
        where: { employeeId: fixture.employee, type: 'PROMOTION' },
      });
      expect(promotion?.title).toContain('Senior Engineer');

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'Employee', entityId: fixture.employee, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.after).toMatchObject({ jobTitle: 'Senior Engineer' });
    });

    it('refuses a reporting line that would create a cycle', async () => {
      // The manager reporting to their own report.
      const response = await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.manager}`)
        .send({ managerId: fixture.employee });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.details)).toContain('cycle');
    });

    it('refuses an employee reporting to themselves', async () => {
      const response = await asUser(adminToken)
        .patch(`/api/v1/employees/${fixture.employee}`)
        .send({ managerId: fixture.employee });

      expect(response.status).toBe(422);
    });

    it('refuses an empty update', async () => {
      const response = await asUser(adminToken).patch(`/api/v1/employees/${fixture.employee}`).send({});
      expect(response.status).toBe(422);
    });

    it('returns 404 for an unknown employee', async () => {
      const response = await asUser(adminToken)
        .patch('/api/v1/employees/does-not-exist')
        .send({ jobTitle: 'Ghost' });
      expect(response.status).toBe(404);
    });
  });

  describe('status changes', () => {
    it('offboards an employee, records the reason and disables their login', async () => {
      const response = await asUser(adminToken).post(`/api/v1/employees/${fixture.colleague}/status`).send({
        status: 'OFFBOARDED',
        effectiveDate: '2026-09-30',
        reason: 'Resignation accepted',
        exitReason: 'Resigned to relocate',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('OFFBOARDED');
      expect(response.body.data.exitDate).toBe('2026-09-30');

      const user = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails.colleague } });
      expect(user.isActive).toBe(false);

      const event = await prisma.employmentEvent.findFirst({
        where: { employeeId: fixture.colleague, type: 'OFFBOARDED' },
      });
      expect(event?.description).toBe('Resignation accepted');
    });

    it('requires an exit reason when offboarding', async () => {
      const response = await asUser(adminToken).post(`/api/v1/employees/${fixture.ksaEmployee}/status`).send({
        status: 'OFFBOARDED',
        effectiveDate: '2026-09-30',
        reason: 'Leaving',
      });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toHaveProperty('exitReason');
    });

    it('refuses a change to the status the employee already holds', async () => {
      const response = await asUser(adminToken).post(`/api/v1/employees/${fixture.employee}/status`).send({
        status: 'ACTIVE',
        effectiveDate: '2026-09-01',
        reason: 'No change',
      });

      expect(response.status).toBe(409);
    });

    it('hides offboarded people from the directory by default', async () => {
      const byDefault = await asUser(adminToken).get('/api/v1/employees?pageSize=100');
      const ids: string[] = byDefault.body.data.map((row: { id: string }) => row.id);
      expect(ids).not.toContain(fixture.colleague);

      const included = await asUser(adminToken).get('/api/v1/employees?pageSize=100&includeOffboarded=true');
      const allIds: string[] = included.body.data.map((row: { id: string }) => row.id);
      expect(allIds).toContain(fixture.colleague);
    });
  });

  describe('search, filter, sort and paginate', () => {
    it('searches across name, employee number and job title', async () => {
      const byName = await asUser(adminToken).get('/api/v1/employees?q=Eve');
      expect(byName.body.data.map((row: { fullName: string }) => row.fullName)).toContain('Eve Employee');

      const byNumber = await asUser(adminToken).get('/api/v1/employees?q=AE-0003');
      expect(byNumber.body.meta.total).toBe(1);

      const byTitle = await asUser(adminToken).get('/api/v1/employees?q=engineer');
      expect(byTitle.body.meta.total).toBeGreaterThan(1);
    });

    it('is case insensitive', async () => {
      const lower = await asUser(adminToken).get('/api/v1/employees?q=eve');
      const upper = await asUser(adminToken).get('/api/v1/employees?q=EVE');
      expect(lower.body.meta.total).toBe(upper.body.meta.total);
      expect(lower.body.meta.total).toBeGreaterThan(0);
    });

    it('filters by legal entity and by multiple statuses', async () => {
      const byEntity = await asUser(adminToken).get(`/api/v1/employees?legalEntityId=${fixture.entitySa}&pageSize=50`);
      const codes = new Set<string>(
        byEntity.body.data.map((row: { legalEntity: { code: string } }) => row.legalEntity.code),
      );
      expect(codes).toEqual(new Set(['TST-SA']));

      const multi = await asUser(adminToken).get('/api/v1/employees?status=ACTIVE,PROBATION&pageSize=50');
      const statuses = new Set<string>(multi.body.data.map((row: { status: string }) => row.status));
      expect([...statuses].every((status) => ['ACTIVE', 'PROBATION'].includes(status))).toBe(true);
    });

    it('sorts by hire date in both directions', async () => {
      const ascending = await asUser(adminToken).get('/api/v1/employees?sortBy=hireDate&sortOrder=asc&pageSize=50');
      const descending = await asUser(adminToken).get('/api/v1/employees?sortBy=hireDate&sortOrder=desc&pageSize=50');

      const first = ascending.body.data[0] as { id: string };
      const last = descending.body.data[0] as { id: string };
      expect(first.id).not.toBe(last.id);
    });

    it('paginates with correct metadata', async () => {
      const page = await asUser(adminToken).get('/api/v1/employees?page=1&pageSize=2');
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.page).toBe(1);
      expect(page.body.meta.pageSize).toBe(2);
      expect(page.body.meta.totalPages).toBe(Math.ceil(page.body.meta.total / 2));
    });

    it('rejects an out-of-range page size', async () => {
      const response = await asUser(adminToken).get('/api/v1/employees?pageSize=5000');
      expect(response.status).toBe(422);
    });

    it('returns an empty page rather than an error when nothing matches', async () => {
      const response = await asUser(adminToken).get('/api/v1/employees?q=zzzznobodyzzz');
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.meta.totalPages).toBe(0);
    });
  });

  describe('compensation history', () => {
    it('closes the previous record when a new one is added', async () => {
      const response = await asUser(adminToken).post(`/api/v1/employees/${fixture.employee}/compensation`).send({
        baseSalary: 26000,
        effectiveFrom: '2026-07-01',
        changeReason: 'Annual review',
      });

      expect(response.status).toBe(201);

      const history = await asUser(adminToken).get(`/api/v1/employees/${fixture.employee}/compensation`);
      expect(history.body.data.current.baseSalary).toBe(26000);
      expect(history.body.data.history).toHaveLength(2);

      const previous = history.body.data.history.find((row: { isCurrent: boolean }) => !row.isCurrent);
      // Closed the day before the new record begins, so the history has no gaps
      // and no overlap.
      expect(previous.effectiveTo).toBe('2026-06-30');
    });

    it('refuses a change dated before the current record', async () => {
      const response = await asUser(adminToken).post(`/api/v1/employees/${fixture.employee}/compensation`).send({
        baseSalary: 30000,
        effectiveFrom: '2026-01-01',
        changeReason: 'Backdated',
      });

      expect(response.status).toBe(422);
    });

    it('keeps the salary amount out of the shared timeline', async () => {
      const timeline = await asUser(employeeToken).get('/api/v1/me/timeline');
      const serialized = JSON.stringify(timeline.body.data);
      // The timeline shows that pay changed, not what it changed to.
      expect(serialized).not.toContain('26000');
    });
  });
});
