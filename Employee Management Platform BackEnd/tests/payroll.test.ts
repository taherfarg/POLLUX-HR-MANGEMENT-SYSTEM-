import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asUser, createFixture, login, resetDatabase, TEST_PASSWORD, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import { hashPassword } from '../src/modules/auth/password';

/**
 * Salary advances, payroll adjustments and a full monthly payroll through the
 * API: calculate, review, four-eyes approval, the financial lock, payslips as
 * stored documents, reopening and marking paid - and who may see which pay.
 *
 * The month under test is August 2026 for the UAE entity (Mon-Fri, 09:00-18:00
 * Dubai time, FIXED_30 day basis). Attendance tracking starts on Thursday 27
 * August, so exactly three working days are tracked: 27, 28 and 31 August.
 *
 *   Mo Manager   20,000 basic, no attendance            -> 3 days absent
 *   Eve Employee 20,000 basic, present 27th, 90 min overtime on the 28th,
 *                absent 31st, 1,000 bonus, 1,000 advance instalment
 *   Cal Colleague 20,000 basic, attendance not tracked   -> no absence
 */

const binary = (res: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

function download(token: string, url: string) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`).buffer(true).parse(binary);
}

describe('advances, adjustments and payroll', () => {
  let fixture: Fixture;
  let adminToken: string;
  let hrAeToken: string;
  let hrKsaToken: string;
  let managerToken: string;
  let employeeToken: string;
  let colleagueToken: string;

  let advanceId: string;
  let bonusId: string;
  let periodId: string;
  let employeeRecordId: string;
  let colleagueRecordId: string;
  let employeePayslipDocumentId: string;
  let aug27RecordId: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();

    // A second UAE HR user, so four-eyes approval has someone to ask.
    const hana = await prisma.employee.create({
      data: {
        employeeNumber: 'AE-0005',
        firstName: 'Hana',
        lastName: 'Hr',
        workEmail: 'hana.hr@test.demo',
        legalEntityId: fixture.entityAe,
        jobTitle: 'HR Officer',
        status: 'ACTIVE',
        hireDate: new Date('2023-01-09T00:00:00.000Z'),
        dateOfBirth: new Date('1991-01-01T00:00:00.000Z'),
        gender: 'UNDISCLOSED',
      },
    });
    await prisma.user.create({
      data: {
        email: 'hr.ae@test.demo',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: 'HR_ADMIN',
        employeeId: hana.id,
        scopedLegalEntityId: fixture.entityAe,
      },
    });

    await prisma.companySettings.create({
      data: {
        legalEntityId: fixture.entityAe,
        displayName: 'Test UAE',
        isPrimary: true,
        attendanceStartDate: new Date('2026-08-27T00:00:00.000Z'),
      },
    });
    await prisma.employee.update({ where: { id: fixture.colleague }, data: { attendanceTracked: false } });

    adminToken = await login(fixture.emails.admin);
    hrAeToken = await login('hr.ae@test.demo');
    hrKsaToken = await login(fixture.emails.hrKsa);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
    colleagueToken = await login(fixture.emails.colleague);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  describe('salary advances', () => {
    it('lets an employee request an advance for themselves', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/advances')
        .send({ amount: 3000, reason: 'Car repair', requestedInstallments: 3 });
      expect(response.status).toBe(201);
      advanceId = response.body.data.id;
      expect(response.body.data.status).toBe('PENDING');
      expect(response.body.data.reference).toMatch(/^ADV-\d{4}-0001$/);
      expect(response.body.data.requestedAmount).toBe(3000);
      expect(response.body.data.currency).toBe('AED');

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'SalaryAdvance', entityId: advanceId } });
      expect(audit?.action).toBe('CREATE');
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('allows only one open advance at a time', async () => {
      const response = await asUser(employeeToken).post('/api/v1/advances').send({ amount: 500, reason: 'Another one' });
      expect(response.status).toBe(409);
    });

    it('refuses a request on behalf of someone else', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/advances')
        .send({ amount: 500, reason: 'For my colleague', employeeId: fixture.colleague });
      expect(response.status).toBe(403);
    });

    it('never shows an advance to the line manager or a colleague', async () => {
      const managerList = await asUser(managerToken).get('/api/v1/advances');
      expect(managerList.status).toBe(200);
      expect(managerList.body.data).toEqual([]);

      expect((await asUser(managerToken).get(`/api/v1/advances/${advanceId}`)).status).toBe(404);
      expect((await asUser(colleagueToken).get(`/api/v1/advances/${advanceId}`)).status).toBe(404);

      // Asking for someone else's advances returns your own, never theirs.
      const colleagueList = await asUser(colleagueToken).get(`/api/v1/advances?employeeId=${fixture.employee}`);
      expect(colleagueList.body.data).toEqual([]);
    });

    it('keeps the decision with HR in scope', async () => {
      const body = { numberOfInstallments: 3, repaymentStartMonth: '2026-08' };
      expect((await asUser(managerToken).post(`/api/v1/advances/${advanceId}/approve`).send(body)).status).toBe(403);
      expect((await asUser(employeeToken).post(`/api/v1/advances/${advanceId}/approve`).send(body)).status).toBe(403);
      expect((await asUser(hrKsaToken).post(`/api/v1/advances/${advanceId}/approve`).send(body)).status).toBe(403);
    });

    it('refuses to approve more than was requested', async () => {
      const response = await asUser(adminToken)
        .post(`/api/v1/advances/${advanceId}/approve`)
        .send({ approvedAmount: 3500, numberOfInstallments: 3, repaymentStartMonth: '2026-08' });
      expect(response.status).toBe(422);
    });

    it('approves with a repayment plan split into instalments', async () => {
      const response = await asUser(adminToken)
        .post(`/api/v1/advances/${advanceId}/approve`)
        .send({ numberOfInstallments: 3, repaymentStartMonth: '2026-08', note: 'Approved' });
      expect(response.status).toBe(200);
      const advance = response.body.data;
      expect(advance.status).toBe('APPROVED');
      expect(advance.approvedAmount).toBe(3000);
      expect(advance.installmentAmount).toBe(1000);
      expect(advance.installments.map((row: { dueMonth: string; amount: number }) => [row.dueMonth, row.amount])).toEqual([
        ['2026-08', 1000],
        ['2026-09', 1000],
        ['2026-10', 1000],
      ]);
      expect(advance.remainingAmount).toBe(3000);
    });

    it('splits an uneven amount exactly, the last instalment taking the remainder', async () => {
      const requested = await asUser(colleagueToken).post('/api/v1/advances').send({ amount: 1000, reason: 'School fees' });
      expect(requested.status).toBe(201);
      const approved = await asUser(adminToken)
        .post(`/api/v1/advances/${requested.body.data.id}/approve`)
        .send({ numberOfInstallments: 3, repaymentStartMonth: '2026-11' });
      expect(approved.status).toBe(200);
      expect(approved.body.data.installments.map((row: { amount: number }) => row.amount)).toEqual([333.33, 333.33, 333.34]);

      // The employee can no longer withdraw an approved advance; HR can cancel it before pay-out.
      expect((await asUser(colleagueToken).post(`/api/v1/advances/${requested.body.data.id}/cancel`)).status).toBe(409);
      const cancelled = await asUser(adminToken).post(`/api/v1/advances/${requested.body.data.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
    });

    it('records the pay-out, after which repayment starts', async () => {
      expect((await asUser(managerToken).post(`/api/v1/advances/${advanceId}/mark-paid`).send({})).status).toBe(403);

      const response = await asUser(adminToken)
        .post(`/api/v1/advances/${advanceId}/mark-paid`)
        .send({ paymentReference: 'TRX-1001' });
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('PAID');
      expect(response.body.data.paymentReference).toBe('TRX-1001');
      expect(response.body.data.nextInstallment).toEqual({ dueMonth: '2026-08', amount: 1000, sequence: 1 });

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'SalaryAdvance', entityId: advanceId, action: 'MARK_PAID' } });
      expect(audit).not.toBeNull();
    });

    it('shows the employee their own advance', async () => {
      const response = await asUser(employeeToken).get(`/api/v1/advances/${advanceId}`);
      expect(response.status).toBe(200);
      expect(response.body.data.remainingAmount).toBe(3000);
      expect(response.body.data.repaidAmount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('payroll adjustments', () => {
    it('is HR-only', async () => {
      const body = { employeeId: fixture.employee, payrollMonth: '2026-08', type: 'BONUS', description: 'Q2 bonus', amount: 1000 };
      expect((await asUser(managerToken).post('/api/v1/payroll/adjustments').send(body)).status).toBe(403);
      expect((await asUser(employeeToken).post('/api/v1/payroll/adjustments').send(body)).status).toBe(403);
      expect((await asUser(hrKsaToken).post('/api/v1/payroll/adjustments').send(body)).status).toBe(403);
      expect((await asUser(managerToken).get('/api/v1/payroll/adjustments')).status).toBe(403);
    });

    it('requires OTHER to say which side of the payslip it is on', async () => {
      const response = await asUser(adminToken)
        .post('/api/v1/payroll/adjustments')
        .send({ employeeId: fixture.employee, payrollMonth: '2026-08', type: 'OTHER', description: 'Something', amount: 10 });
      expect(response.status).toBe(422);
    });

    it('creates a pending bonus that its author cannot approve', async () => {
      const created = await asUser(adminToken)
        .post('/api/v1/payroll/adjustments')
        .send({ employeeId: fixture.employee, payrollMonth: '2026-08', type: 'BONUS', description: 'Q2 performance bonus', amount: 1000 });
      expect(created.status).toBe(201);
      bonusId = created.body.data.id;
      expect(created.body.data.status).toBe('PENDING');
      expect(created.body.data.kind).toBe('EARNING');
      expect(created.body.data.amount).toBe(1000);

      const own = await asUser(adminToken).post(`/api/v1/payroll/adjustments/${bonusId}/approve`).send({});
      expect(own.status).toBe(403);
    });

    it('is approved by a second HR user', async () => {
      const response = await asUser(hrAeToken).post(`/api/v1/payroll/adjustments/${bonusId}/approve`).send({ note: 'Checked' });
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('APPROVED');

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'PayrollAdjustment', entityId: bonusId, action: 'APPROVE' } });
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('lists adjustments for HR with a status summary', async () => {
      const response = await asUser(adminToken).get('/api/v1/payroll/adjustments?payrollMonth=2026-08');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.summary.APPROVED).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('attendance feeding the payroll', () => {
    it('records the tracked days and approves the overtime', async () => {
      const present = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.employee,
        date: '2026-08-27',
        checkIn: '09:00',
        checkOut: '18:00',
        reason: 'Imported from the door system',
      });
      expect(present.status).toBe(201);
      aug27RecordId = present.body.data.id;

      const late = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.employee,
        date: '2026-08-28',
        checkIn: '09:00',
        checkOut: '19:30',
        reason: 'Imported from the door system',
      });
      expect(late.status).toBe(201);
      expect(late.body.data.overtimeMinutes).toBe(90);

      const overtime = await prisma.overtimeEntry.findUniqueOrThrow({ where: { attendanceId: late.body.data.id } });
      expect(overtime.status).toBe('PENDING');
      const approved = await asUser(managerToken).post(`/api/v1/overtime/${overtime.id}/approve`).send({});
      expect(approved.status).toBe(200);
    });

    it('treats days before tracking started as untracked, not absent', async () => {
      const response = await asUser(adminToken).get(
        `/api/v1/attendance/timesheet?employeeId=${fixture.manager}&from=2026-08-24&to=2026-08-31`,
      );
      expect(response.status).toBe(200);
      const byDate = Object.fromEntries(
        (response.body.data.days as { date: string; status: string }[]).map((day) => [day.date, day.status]),
      );
      expect(byDate['2026-08-26']).toBe('NOT_TRACKED');
      expect(byDate['2026-08-27']).toBe('ABSENT');
      expect(byDate['2026-08-31']).toBe('ABSENT');
    });
  });

  // ---------------------------------------------------------------------------
  describe('the monthly payroll', () => {
    it('is not visible to managers, employees or HR outside the entity', async () => {
      expect((await asUser(managerToken).get('/api/v1/payroll/periods')).status).toBe(403);
      expect((await asUser(employeeToken).get('/api/v1/payroll/periods')).status).toBe(403);
      expect((await asUser(managerToken).post('/api/v1/payroll/periods').send({ year: 2026, month: 8 })).status).toBe(403);
    });

    it('creates the period for the company', async () => {
      const response = await asUser(adminToken).post('/api/v1/payroll/periods').send({ year: 2026, month: 8 });
      expect(response.status).toBe(201);
      periodId = response.body.data.id;
      expect(response.body.data).toMatchObject({
        name: 'August 2026',
        status: 'DRAFT',
        currency: 'AED',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        payDate: '2026-08-28',
        legalEntityId: fixture.entityAe,
      });

      const duplicate = await asUser(adminToken).post('/api/v1/payroll/periods').send({ year: 2026, month: 8 });
      expect(duplicate.status).toBe(409);

      expect((await asUser(hrKsaToken).get(`/api/v1/payroll/periods/${periodId}`)).status).toBe(403);
      const ksaList = await asUser(hrKsaToken).get('/api/v1/payroll/periods');
      expect(ksaList.body.data).toEqual([]);
    });

    it('refuses to approve a payroll that was never calculated or reviewed', async () => {
      const response = await asUser(hrAeToken).post(`/api/v1/payroll/periods/${periodId}/approve`);
      expect(response.status).toBe(409);
    });

    it('calculates every employee from salary, attendance, overtime, adjustments and advances', async () => {
      const response = await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/calculate`);
      expect(response.status).toBe(200);
      const period = response.body.data;
      expect(period.status).toBe('CALCULATED');
      expect(period.employeeCount).toBe(3);
      // Nobody without a recorded salary is paid by accident.
      expect(period.skipped.map((row: { employeeNumber: string }) => row.employeeNumber).sort()).toEqual(['AE-0001', 'AE-0005']);
      expect(period.totalGross).toBe(61156.25);
      expect(period.totalDeductions).toBe(3666.67);
      expect(period.totalNet).toBe(57489.58);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'PayrollPeriod', entityId: periodId, action: 'CALCULATE' } });
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('shows the register to HR, and records that it was opened', async () => {
      const response = await asUser(adminToken).get(`/api/v1/payroll/periods/${periodId}`);
      expect(response.status).toBe(200);
      const byNumber = Object.fromEntries(
        (response.body.data.records as { employee: { employeeNumber: string }; netSalary: number }[]).map((record) => [
          record.employee.employeeNumber,
          record,
        ]),
      );
      expect(byNumber['AE-0002']).toMatchObject({ grossEarnings: 20000, totalDeductions: 2000, netSalary: 18000, absentDays: 3 });
      expect(byNumber['AE-0003']).toMatchObject({ grossEarnings: 21156.25, totalDeductions: 1666.67, netSalary: 19489.58, absentDays: 1, overtimeMinutes: 90 });
      expect(byNumber['AE-0004']).toMatchObject({ grossEarnings: 20000, totalDeductions: 0, netSalary: 20000, absentDays: 0 });

      const viewed = await prisma.auditLog.findFirst({ where: { entityType: 'PayrollPeriod', entityId: periodId, action: 'VIEW_SENSITIVE' } });
      expect(viewed).not.toBeNull();
    });

    it('itemises every line with its source', async () => {
      const record = await prisma.payrollRecord.findFirstOrThrow({ where: { periodId, employeeId: fixture.employee } });
      employeeRecordId = record.id;
      colleagueRecordId = (await prisma.payrollRecord.findFirstOrThrow({ where: { periodId, employeeId: fixture.colleague } })).id;

      const response = await asUser(adminToken).get(`/api/v1/payroll/records/${employeeRecordId}`);
      expect(response.status).toBe(200);
      const lines = (response.body.data.items as { type: string; amount: number; sourceType: string | null }[]).map((item) => [
        item.type,
        item.amount,
        item.sourceType,
      ]);
      expect(lines).toEqual([
        ['BASIC_SALARY', 20000, null],
        ['OVERTIME', 156.25, 'OvertimeEntry'],
        ['BONUS', 1000, 'PayrollAdjustment'],
        ['ADVANCE_DEDUCTION', 1000, 'SalaryAdvanceInstallment'],
        ['ABSENCE', 666.67, null],
      ]);
    });

    it('does not show a calculated payroll line to the employee before approval', async () => {
      expect((await asUser(employeeToken).get(`/api/v1/payroll/records/${employeeRecordId}`)).status).toBe(404);
      const payslips = await asUser(employeeToken).get('/api/v1/payslips');
      expect(payslips.body.data).toEqual([]);
    });

    it('reviews, then keeps the calculator from approving their own payroll', async () => {
      const reviewed = await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/review`);
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.data.status).toBe('REVIEWED');

      const selfApproval = await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/approve`);
      expect(selfApproval.status).toBe(403);
    });

    it('refuses approval when an input changed after the review', async () => {
      const deduction = await asUser(adminToken)
        .post('/api/v1/payroll/adjustments')
        .send({ employeeId: fixture.employee, payrollMonth: '2026-08', type: 'DEDUCTION', description: 'Uniform', amount: 200 });
      expect(deduction.status).toBe(201);
      expect((await asUser(hrAeToken).post(`/api/v1/payroll/adjustments/${deduction.body.data.id}/approve`).send({})).status).toBe(200);

      const response = await asUser(hrAeToken).post(`/api/v1/payroll/periods/${periodId}/approve`);
      expect(response.status).toBe(409);
      expect(response.body.error.details.changedEmployees).toEqual(['Eve Employee']);
    });

    it('is approved by a second person after recalculation and review', async () => {
      const recalculated = await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/calculate`);
      expect(recalculated.body.data.totalNet).toBe(57289.58);
      expect(recalculated.body.data.reviewedAt).toBeNull();
      expect((await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/review`)).status).toBe(200);

      const approved = await asUser(hrAeToken).post(`/api/v1/payroll/periods/${periodId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('APPROVED');
      expect(approved.body.data.isLocked).toBe(true);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'PayrollPeriod', entityId: periodId, action: 'APPROVE' } });
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('stores a PDF payslip as each employee\'s document', async () => {
      const documents = await prisma.document.findMany({ where: { category: 'PAYSLIP' }, include: { file: true } });
      expect(documents).toHaveLength(3);
      for (const document of documents) {
        expect(document.file?.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Buffer.from(document.file?.data ?? []).subarray(0, 4).toString()).toBe('%PDF');
      }
      const record = await prisma.payrollRecord.findUniqueOrThrow({ where: { id: employeeRecordId } });
      expect(record.payslipDocumentId).toBeTruthy();
      employeePayslipDocumentId = record.payslipDocumentId as string;
    });

    it('consumes the advance instalment and links every source to its payslip line', async () => {
      const advance = await asUser(employeeToken).get(`/api/v1/advances/${advanceId}`);
      expect(advance.body.data.status).toBe('ACTIVE');
      expect(advance.body.data.repaidAmount).toBe(1000);
      expect(advance.body.data.remainingAmount).toBe(2000);
      expect(advance.body.data.installments[0]).toMatchObject({ status: 'DEDUCTED', payrollPeriod: { name: 'August 2026', status: 'APPROVED' } });
      expect(advance.body.data.nextInstallment).toMatchObject({ dueMonth: '2026-09', sequence: 2 });

      const bonus = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id: bonusId } });
      expect(bonus.payrollItemId).toBeTruthy();
      const overtime = await prisma.overtimeEntry.findFirstOrThrow({ where: { employeeId: fixture.employee } });
      expect(overtime.payrollItemId).toBeTruthy();
    });

    it('locks the month: no recalculation, no attendance edits, no new adjustments', async () => {
      expect((await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/calculate`)).status).toBe(409);
      expect((await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/cancel`).send({})).status).toBe(409);

      const correction = await asUser(adminToken)
        .patch(`/api/v1/attendance/${aug27RecordId}`)
        .send({ checkIn: '10:00', reason: 'Late correction' });
      expect(correction.status).toBe(409);

      const newDay = await asUser(adminToken).post('/api/v1/attendance').send({
        employeeId: fixture.employee,
        date: '2026-08-31',
        checkIn: '09:00',
        checkOut: '18:00',
        reason: 'Forgot to check in',
      });
      expect(newDay.status).toBe(409);

      const adjustment = await asUser(adminToken)
        .post('/api/v1/payroll/adjustments')
        .send({ employeeId: fixture.colleague, payrollMonth: '2026-08', type: 'BONUS', description: 'Late bonus', amount: 100 });
      expect(adjustment.status).toBe(409);

      const deletePayslip = await asUser(adminToken).delete(`/api/v1/documents/${employeePayslipDocumentId}`);
      expect(deletePayslip.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  describe('payslips', () => {
    it('lists only the employee\'s own payslips', async () => {
      const response = await asUser(employeeToken).get('/api/v1/payslips');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({ id: employeeRecordId, netSalary: 19289.58, hasPayslip: true });

      // Asking for someone else's payslips returns your own, never theirs.
      const filtered = await asUser(employeeToken).get(`/api/v1/payslips?employeeId=${fixture.colleague}`);
      expect(filtered.body.data.map((row: { id: string }) => row.id)).toEqual([employeeRecordId]);
    });

    it('serves the stored PDF to the employee', async () => {
      const response = await download(employeeToken, `/api/v1/payslips/${employeeRecordId}/pdf`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-disposition']).toMatch(/^inline; filename="payslip-2026-08-AE-0003\.pdf"$/);
      expect((response.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const asDocument = await download(employeeToken, `/api/v1/documents/${employeePayslipDocumentId}/download?download=1`);
      expect(asDocument.status).toBe(200);
      expect(asDocument.headers['content-disposition']).toMatch(/^attachment;/);
      expect((asDocument.body as Buffer).equals(response.body as Buffer)).toBe(true);
    });

    it('lists the payslip among the employee\'s documents without loading the file', async () => {
      const response = await asUser(employeeToken).get(`/api/v1/employees/${fixture.employee}/documents`);
      expect(response.status).toBe(200);
      const payslip = response.body.data.find((document: { id: string }) => document.id === employeePayslipDocumentId);
      expect(payslip).toMatchObject({ category: 'PAYSLIP', hasStoredFile: true, downloadUrl: `/api/v1/documents/${employeePayslipDocumentId}/download` });
      expect(payslip.file).toBeUndefined();
    });

    it('never serves a payslip to a colleague, the line manager or HR outside the entity', async () => {
      for (const token of [colleagueToken, managerToken, hrKsaToken]) {
        expect((await download(token, `/api/v1/payslips/${employeeRecordId}/pdf`)).status).toBe(404);
        expect((await asUser(token).get(`/api/v1/payroll/records/${employeeRecordId}`)).status).toBe(404);
        expect([403, 404]).toContain((await download(token, `/api/v1/documents/${employeePayslipDocumentId}/download`)).status);
      }
      expect((await asUser(employeeToken).get(`/api/v1/payroll/records/${colleagueRecordId}`)).status).toBe(404);
    });

    it('audits HR opening someone else\'s payslip', async () => {
      const response = await download(adminToken, `/api/v1/payslips/${employeeRecordId}/pdf`);
      expect(response.status).toBe(200);
      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'PayrollRecord', entityId: employeeRecordId, action: 'VIEW_SENSITIVE' },
      });
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });
  });

  // ---------------------------------------------------------------------------
  describe('reopening and paying', () => {
    it('reopening is for administrators only, with a reason', async () => {
      expect((await asUser(hrAeToken).post(`/api/v1/payroll/periods/${periodId}/reopen`).send({ reason: 'Wrong bonus amount' })).status).toBe(403);
      expect((await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/reopen`).send({})).status).toBe(422);
    });

    it('undoes everything approval did', async () => {
      const response = await asUser(adminToken)
        .post(`/api/v1/payroll/periods/${periodId}/reopen`)
        .send({ reason: 'Bonus amount to be confirmed' });
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('CALCULATED');
      expect(response.body.data.reopenCount).toBe(1);

      expect(await prisma.document.count({ where: { category: 'PAYSLIP' } })).toBe(0);
      const advance = await asUser(employeeToken).get(`/api/v1/advances/${advanceId}`);
      expect(advance.body.data.status).toBe('PAID');
      expect(advance.body.data.remainingAmount).toBe(3000);
      expect(advance.body.data.installments[0].status).toBe('SCHEDULED');
      expect((await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id: bonusId } })).payrollItemId).toBeNull();

      // Withdrawn from the employee as well.
      expect((await asUser(employeeToken).get('/api/v1/payslips')).body.data).toEqual([]);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'PayrollPeriod', entityId: periodId, action: 'REOPEN' } });
      expect(audit?.summary).toContain('Bonus amount to be confirmed');
    });

    it('approves again and marks the payroll paid, after which it is final', async () => {
      expect((await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/review`)).status).toBe(200);
      expect((await asUser(hrAeToken).post(`/api/v1/payroll/periods/${periodId}/approve`)).status).toBe(200);

      const paid = await asUser(adminToken)
        .post(`/api/v1/payroll/periods/${periodId}/mark-paid`)
        .send({ paidOn: '2026-08-28', paymentReference: 'WPS-2026-08' });
      expect(paid.status).toBe(200);
      expect(paid.body.data.status).toBe('PAID');
      expect(paid.body.data.paymentReference).toBe('WPS-2026-08');

      const reopen = await asUser(adminToken).post(`/api/v1/payroll/periods/${periodId}/reopen`).send({ reason: 'Too late now' });
      expect(reopen.status).toBe(409);

      const advance = await asUser(employeeToken).get(`/api/v1/advances/${advanceId}`);
      expect(advance.body.data.remainingAmount).toBe(2000);
    });

    it('deducts the next instalment - and only that one - in the following month', async () => {
      const created = await asUser(adminToken).post('/api/v1/payroll/periods').send({ year: 2026, month: 9 });
      expect(created.status).toBe(201);
      const calculated = await asUser(adminToken).post(`/api/v1/payroll/periods/${created.body.data.id}/calculate`);
      expect(calculated.status).toBe(200);

      const record = await prisma.payrollRecord.findFirstOrThrow({
        where: { periodId: created.body.data.id, employeeId: fixture.employee },
        include: { items: true },
      });
      const advanceLines = record.items.filter((item) => item.type === 'ADVANCE_DEDUCTION');
      expect(advanceLines).toHaveLength(1);
      expect(advanceLines[0]?.label).toContain('(2/3)');
      expect(Number(advanceLines[0]?.amount)).toBe(1000);
      // The August bonus and overtime were paid in August.
      expect(record.items.some((item) => item.sourceId === bonusId)).toBe(false);
      expect(record.items.some((item) => item.type === 'OVERTIME')).toBe(false);
    });
  });
});
