import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';

/**
 * The three self-service workflows, each driven the way a user drives them:
 * submit, see the status, get a decision, see the effect.
 */
describe('request workflows', () => {
  let fixture: Fixture;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let colleagueToken: string;

  const annualBalance = async (employeeId = fixture.employee) => {
    const balance = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: fixture.annualAe, year: 2026 },
    });
    return {
      used: Number(balance.usedDays),
      pending: Number(balance.pendingDays),
      entitled: Number(balance.entitledDays),
    };
  };

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
    colleagueToken = await login(fixture.emails.colleague);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('leave', () => {
    it('previews the chargeable days before submitting', async () => {
      // Mon 9 Nov to Fri 13 Nov 2026, no holidays in range.
      const response = await asUser(employeeToken)
        .post('/api/v1/requests/leave/preview')
        .send({ startDate: '2026-11-09', endDate: '2026-11-13' });

      expect(response.status).toBe(200);
      expect(response.body.data.workingDays).toBe(5);
    });

    it('excludes the entity public holiday from the preview', async () => {
      // Mon 2 Nov to Fri 6 Nov 2026 contains the seeded Wednesday holiday.
      const response = await asUser(employeeToken)
        .post('/api/v1/requests/leave/preview')
        .send({ startDate: '2026-11-02', endDate: '2026-11-06' });

      expect(response.body.data.workingDays).toBe(4);
      expect(response.body.data.holidaysInRange).toHaveLength(1);
    });

    it('runs the full submit, hold, approve and deduct cycle', async () => {
      const before = await annualBalance();

      const submitted = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe,
        startDate: '2026-11-09',
        endDate: '2026-11-13',
        reason: 'Family holiday',
      });

      expect(submitted.status).toBe(201);
      expect(submitted.body.data.status).toBe('PENDING');
      expect(submitted.body.data.reference).toMatch(/^LV-\d{4}-\d{4}$/);
      expect(submitted.body.data.leave.workingDays).toBe(5);

      // Submitting holds the days so they cannot be booked twice.
      const held = await annualBalance();
      expect(held.pending).toBe(before.pending + 5);
      expect(held.used).toBe(before.used);

      const requestId = submitted.body.data.id as string;
      const approved = await asUser(adminToken)
        .post(`/api/v1/requests/${requestId}/approve`)
        .send({ note: 'Approved' });

      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('APPROVED');
      expect(approved.body.data.decidedBy.fullName).toBe('Ada Admin');

      // Approval converts the hold into a deduction; the total charged is stable.
      const after = await annualBalance();
      expect(after.pending).toBe(before.pending);
      expect(after.used).toBe(before.used + 5);

      // The employee can see the decision on their own request.
      const seen = await asUser(employeeToken).get(`/api/v1/requests/${requestId}`);
      expect(seen.body.data.status).toBe('APPROVED');
      expect(seen.body.data.decisionNote).toBe('Approved');
    });

    it('returns the held days when a request is rejected', async () => {
      const before = await annualBalance();

      const submitted = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe,
        startDate: '2026-11-23',
        endDate: '2026-11-25',
        reason: 'Short break',
      });
      expect(submitted.status).toBe(201);
      expect((await annualBalance()).pending).toBe(before.pending + 3);

      const rejected = await asUser(adminToken)
        .post(`/api/v1/requests/${submitted.body.data.id}/reject`)
        .send({ note: 'Clashes with the release window' });

      expect(rejected.status).toBe(200);
      const after = await annualBalance();
      expect(after.pending).toBe(before.pending);
      expect(after.used).toBe(before.used);
    });

    it('returns the held days when the employee withdraws the request', async () => {
      const before = await annualBalance();

      const submitted = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe,
        startDate: '2026-12-07',
        endDate: '2026-12-08',
        reason: 'Personal',
      });

      const cancelled = await asUser(employeeToken).post(`/api/v1/requests/${submitted.body.data.id}/cancel`).send({});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect((await annualBalance()).pending).toBe(before.pending);
    });

    it('rejects a rejection with no reason', async () => {
      const submitted = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-12-14', endDate: '2026-12-15', reason: 'Personal',
      });
      const response = await asUser(adminToken).post(`/api/v1/requests/${submitted.body.data.id}/reject`).send({});

      expect(response.status).toBe(422);
      await asUser(employeeToken).post(`/api/v1/requests/${submitted.body.data.id}/cancel`).send({});
    });

    it('refuses overlapping dates', async () => {
      const first = await asUser(colleagueToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-10-05', endDate: '2026-10-09', reason: 'Trip',
      });
      expect(first.status).toBe(201);

      const overlapping = await asUser(colleagueToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-10-08', endDate: '2026-10-12', reason: 'Overlap',
      });

      expect(overlapping.status).toBe(422);
      expect(JSON.stringify(overlapping.body.error.details)).toContain('overlap');
    });

    it('refuses a request that exceeds the remaining balance', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe,
        startDate: '2026-06-01',
        endDate: '2026-09-30',
        reason: 'Four months off',
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.details)).toContain('remain');
    });

    it('refuses a range that contains no working days', async () => {
      // Saturday and Sunday, which are not working days in the UAE entity.
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-11-07', endDate: '2026-11-08', reason: 'Weekend',
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.details)).toContain('no working days');
    });

    it('refuses an end date before the start date', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-11-13', endDate: '2026-11-09', reason: 'Backwards',
      });
      expect(response.status).toBe(422);
    });

    it('refuses leave that spans two calendar years', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-12-28', endDate: '2027-01-05', reason: 'New year',
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.details)).toContain('two calendar years');
    });

    it('refuses a leave type belonging to another legal entity', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualSa, startDate: '2026-11-16', endDate: '2026-11-17', reason: 'Wrong entity',
      });

      expect(response.status).toBe(422);
    });

    it('blocks an employee from filing leave for someone else', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        employeeId: fixture.colleague,
        leaveTypeId: fixture.annualAe, startDate: '2026-11-16', endDate: '2026-11-17', reason: 'Not mine',
      });

      expect(response.status).toBe(403);
    });

    it('lets HR file leave on behalf of an employee', async () => {
      const response = await asUser(adminToken).post('/api/v1/requests/leave').send({
        employeeId: fixture.colleague,
        leaveTypeId: fixture.annualAe, startDate: '2026-11-16', endDate: '2026-11-17',
        reason: 'Submitted by HR on request',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.employee.id).toBe(fixture.colleague);
    });

    it('lets HR record leave that has already started, with no notice period, and approve it', async () => {
      // The notice period binds the employee planning ahead, not HR recording
      // leave that was agreed in person or has already begun.
      await prisma.leaveType.update({ where: { id: fixture.annualAe }, data: { minNoticeDays: 7 } });
      try {
        const own = await asUser(employeeToken).post('/api/v1/requests/leave').send({
          leaveTypeId: fixture.annualAe, startDate: '2026-09-07', endDate: '2026-09-10', reason: 'Backdated by myself',
        });
        expect(own.status).toBe(422);

        const before = await annualBalance(fixture.colleague);
        const recorded = await asUser(adminToken).post('/api/v1/requests/leave').send({
          employeeId: fixture.colleague,
          leaveTypeId: fixture.annualAe, startDate: '2026-09-07', endDate: '2026-09-10',
          reason: 'Annual leave agreed before it was recorded',
        });
        expect(recorded.status).toBe(201);
        expect(recorded.body.data.status).toBe('PENDING');

        // The person who recorded it may decide it: it is the colleague's request, not theirs.
        const approved = await asUser(adminToken).post(`/api/v1/requests/${recorded.body.data.id}/approve`).send({ note: 'Recorded and approved by HR' });
        expect(approved.status).toBe(200);
        expect(approved.body.data.status).toBe('APPROVED');

        const after = await annualBalance(fixture.colleague);
        expect(after.used - before.used).toBe(4); // Monday 7 to Thursday 10 September
        expect(after.pending).toBe(before.pending);
      } finally {
        await prisma.leaveType.update({ where: { id: fixture.annualAe }, data: { minNoticeDays: 0 } });
      }
    });
  });

  describe('approval rules', () => {
    let pendingRequestId: string;

    beforeAll(async () => {
      const submitted = await asUser(employeeToken).post('/api/v1/requests/leave').send({
        leaveTypeId: fixture.annualAe, startDate: '2026-12-21', endDate: '2026-12-22', reason: 'Year end',
      });
      pendingRequestId = submitted.body.data.id as string;
    });

    it('blocks the requester from approving their own request', async () => {
      const response = await asUser(employeeToken).post(`/api/v1/requests/${pendingRequestId}/approve`).send({});
      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain('your own');
    });

    it('blocks an unrelated colleague from deciding', async () => {
      const response = await asUser(colleagueToken).post(`/api/v1/requests/${pendingRequestId}/approve`).send({});
      expect(response.status).toBe(403);
    });

    it('lets the direct line manager decide', async () => {
      const response = await asUser(managerToken).post(`/api/v1/requests/${pendingRequestId}/approve`).send({});
      expect(response.status).toBe(200);
    });

    it('refuses a second decision on an already decided request', async () => {
      const response = await asUser(adminToken).post(`/api/v1/requests/${pendingRequestId}/approve`).send({});
      expect(response.status).toBe(409);
    });

    it('hides an unrelated request behind a 404 rather than a 403', async () => {
      const response = await asUser(colleagueToken).get(`/api/v1/requests/${pendingRequestId}`);
      expect(response.status).toBe(404);
    });
  });

  describe('document requests', () => {
    it('issues a document on approval and files it under the employee', async () => {
      const submitted = await asUser(employeeToken).post('/api/v1/requests/document').send({
        documentType: 'EMPLOYMENT_CERTIFICATE',
        purpose: 'Tenancy contract',
      });

      expect(submitted.status).toBe(201);
      expect(submitted.body.data.reference).toMatch(/^DOC-\d{4}-\d{4}$/);

      const approved = await asUser(adminToken)
        .post(`/api/v1/requests/${submitted.body.data.id}/approve`)
        .send({ note: 'Issued' });

      expect(approved.status).toBe(200);
      expect(approved.body.data.document.issuedDocument).not.toBeNull();

      const documents = await asUser(employeeToken).get('/api/v1/me/documents');
      const titles: string[] = documents.body.data.map((row: { title: string }) => row.title);
      expect(titles).toContain('Employment Certificate');
    });

    it('forces includeSalary on a salary certificate', async () => {
      const submitted = await asUser(employeeToken).post('/api/v1/requests/document').send({
        documentType: 'SALARY_CERTIFICATE',
        purpose: 'Bank loan',
        includeSalary: false,
      });

      expect(submitted.body.data.document.includeSalary).toBe(true);
    });

    it('rejects an unknown document type', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/requests/document')
        .send({ documentType: 'SECRET_DOSSIER', purpose: 'Testing' });
      expect(response.status).toBe(422);
    });
  });

  describe('profile change requests', () => {
    it('applies the approved change to the employee record', async () => {
      const submitted = await asUser(employeeToken).post('/api/v1/requests/profile-change').send({
        changes: { phone: '+971 50 111 2222', city: 'Abu Dhabi' },
      });

      expect(submitted.status).toBe(201);
      expect(submitted.body.data.profileChange.changeCount).toBe(2);

      // Nothing changes until it is approved.
      const beforeApproval = await prisma.employee.findUniqueOrThrow({ where: { id: fixture.employee } });
      expect(beforeApproval.phone).toBe('+971 50 000 0000');

      await asUser(adminToken).post(`/api/v1/requests/${submitted.body.data.id}/approve`).send({ note: 'Verified' });

      const afterApproval = await prisma.employee.findUniqueOrThrow({ where: { id: fixture.employee } });
      expect(afterApproval.phone).toBe('+971 50 111 2222');
      expect(afterApproval.city).toBe('Abu Dhabi');
    });

    it('does not apply a rejected change', async () => {
      const submitted = await asUser(colleagueToken).post('/api/v1/requests/profile-change').send({
        changes: { phone: '+971 50 999 9999' },
      });

      await asUser(adminToken)
        .post(`/api/v1/requests/${submitted.body.data.id}/reject`)
        .send({ note: 'Needs supporting document' });

      const employee = await prisma.employee.findUniqueOrThrow({ where: { id: fixture.colleague } });
      expect(employee.phone).toBe('+971 50 000 0000');
    });

    /**
     * The important negative case: job title, salary and legal entity are not in
     * the schema, so they cannot be smuggled through self-service.
     */
    it('ignores fields outside the self-service allowlist', async () => {
      const response = await asUser(employeeToken).post('/api/v1/requests/profile-change').send({
        changes: { phone: '+971 50 333 4444', jobTitle: 'Chief Executive Officer', baseSalary: 999999 },
      });

      expect(response.status).toBe(201);
      const fields: string[] = response.body.data.profileChange.changes.map((c: { field: string }) => c.field);
      expect(fields).toEqual(['phone']);

      await asUser(adminToken).post(`/api/v1/requests/${response.body.data.id}/approve`).send({});
      const employee = await prisma.employee.findUniqueOrThrow({ where: { id: fixture.employee } });
      expect(employee.jobTitle).toBe('Engineer');
    });

    it('refuses a second pending profile change', async () => {
      const first = await asUser(employeeToken)
        .post('/api/v1/requests/profile-change')
        .send({ changes: { city: 'Sharjah' } });
      expect(first.status).toBe(201);

      const second = await asUser(employeeToken)
        .post('/api/v1/requests/profile-change')
        .send({ changes: { city: 'Ajman' } });
      expect(second.status).toBe(409);

      await asUser(employeeToken).post(`/api/v1/requests/${first.body.data.id}/cancel`).send({});
    });

    it('refuses a change that matches the stored value', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/requests/profile-change')
        .send({ changes: { city: 'Abu Dhabi' } });

      expect(response.status).toBe(422);
    });
  });

  describe('the request inbox', () => {
    it('shows an employee only their own requests', async () => {
      const response = await asUser(employeeToken).get('/api/v1/requests?pageSize=100');
      const owners: string[] = response.body.data.map((row: { employee: { id: string } }) => row.employee.id);
      expect(owners.every((id) => id === fixture.employee)).toBe(true);
    });

    it('shows a manager their own requests and their team', async () => {
      const response = await asUser(managerToken).get('/api/v1/requests?pageSize=100');
      const owners = new Set<string>(
        response.body.data.map((row: { employee: { id: string } }) => row.employee.id),
      );
      expect(owners.has(fixture.employee)).toBe(true);
      expect(owners.has(fixture.colleague)).toBe(false);
    });

    it('returns status counts alongside the page', async () => {
      const response = await asUser(adminToken).get('/api/v1/requests?pageSize=5');
      expect(response.body.summary).toHaveProperty('PENDING');
      expect(response.body.meta.total).toBeGreaterThan(response.body.data.length);
    });

    it('filters by type and status', async () => {
      const response = await asUser(adminToken).get('/api/v1/requests?type=LEAVE&status=APPROVED&pageSize=100');
      const types = new Set<string>(response.body.data.map((row: { type: string }) => row.type));
      const statuses = new Set<string>(response.body.data.map((row: { status: string }) => row.status));
      expect(types).toEqual(new Set(['LEAVE']));
      expect(statuses).toEqual(new Set(['APPROVED']));
    });

    it('hides the private reason from a colleague on the shared calendar', async () => {
      const response = await asUser(colleagueToken).get('/api/v1/leave/calendar?from=2026-11-01&to=2026-11-30');
      expect(response.status).toBe(200);
      const others = response.body.data.filter(
        (row: { employee: { id: string } }) => row.employee.id !== fixture.colleague,
      );
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((row: { reason: string | null }) => row.reason === null)).toBe(true);
    });
  });
});
