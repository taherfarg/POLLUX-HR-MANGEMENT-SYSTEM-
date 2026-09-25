import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import type { AuthContext } from '../../common/auth-context';
import { auditScopeWhere, entityScopeWhere, scopedEntityId } from '../../services/access';
import { sum, toAmount, ZERO, type Money } from '../../services/money';
import { loadHolidayDates, loadWorkContext } from '../../services/work-context';
import { zonedDateKey } from '../../services/timezone';
import { toDateKey } from '../../services/working-days';
import { getBoard, getMyToday } from '../attendance/attendance.service';

/**
 * The Pollux dashboard panels: today's attendance, what is waiting for a
 * decision, recent activity and - for HR and administrators only - payroll.
 *
 * Everything is read through the same services the pages use (the attendance
 * board, the payroll periods), so a number on the dashboard always matches
 * the page it links to.
 */

type BoardResult = {
  counts: Record<string, number>;
  rows: Record<string, unknown>[];
  missingCheckouts: Record<string, unknown>[];
};

const employeeLabelSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  avatarUrl: true,
} as const;

function label(employee: { id: string; employeeNumber: string; firstName: string; lastName: string; jobTitle: string; avatarUrl: string | null }) {
  return { ...employee, fullName: `${employee.firstName} ${employee.lastName}` };
}

async function boardOrNull(auth: AuthContext, now: Date): Promise<BoardResult | null> {
  try {
    return (await getBoard(auth, {}, now)) as BoardResult;
  } catch {
    // A manager with no direct reports has no board.
    return null;
  }
}

/** HR / administrator panels. */
export async function getManagementPanels(auth: AuthContext, now: Date = new Date()): Promise<Record<string, unknown>> {
  const scope = scopedEntityId(auth);
  const entityWhere = scope ? { legalEntityId: scope } : {};
  const employeeScope = entityScopeWhere(auth);
  const active: Prisma.EmployeeWhereInput = { ...employeeScope, status: { not: 'OFFBOARDED' } };

  const [
    board,
    totalEmployees,
    remoteEmployees,
    pendingLeave,
    pendingLeaveCount,
    pendingOtherRequests,
    pendingAdvances,
    pendingAdvanceCount,
    pendingOvertime,
    pendingOvertimeCount,
    pendingAdjustmentCount,
    periods,
    outstandingAdvances,
    recentActivity,
  ] = await Promise.all([
    boardOrNull(auth, now),
    prisma.employee.count({ where: active }),
    prisma.employee.count({ where: { ...active, workMode: 'REMOTE' } }),
    prisma.request.findMany({
      where: { status: 'PENDING', type: 'LEAVE', ...entityWhere },
      select: {
        id: true,
        reference: true,
        submittedAt: true,
        employee: { select: employeeLabelSelect },
        leaveDetail: { select: { startDate: true, endDate: true, workingDays: true, leaveType: { select: { name: true, colorHex: true } } } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 6,
    }),
    prisma.request.count({ where: { status: 'PENDING', type: 'LEAVE', ...entityWhere } }),
    prisma.request.count({ where: { status: 'PENDING', type: { not: 'LEAVE' }, ...entityWhere } }),
    prisma.salaryAdvance.findMany({
      where: { status: 'PENDING', ...entityWhere },
      select: { id: true, reference: true, requestedAmount: true, currency: true, requestDate: true, employee: { select: employeeLabelSelect } },
      orderBy: { requestDate: 'asc' },
      take: 5,
    }),
    prisma.salaryAdvance.count({ where: { status: 'PENDING', ...entityWhere } }),
    prisma.overtimeEntry.findMany({
      where: { status: 'PENDING', ...entityWhere },
      select: { id: true, date: true, minutes: true, employee: { select: employeeLabelSelect } },
      orderBy: { date: 'asc' },
      take: 5,
    }),
    prisma.overtimeEntry.count({ where: { status: 'PENDING', ...entityWhere } }),
    prisma.payrollAdjustment.count({ where: { status: 'PENDING', ...entityWhere } }),
    prisma.payrollPeriod.findMany({
      where: { status: { not: 'CANCELLED' }, ...entityWhere },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 12,
    }),
    prisma.salaryAdvance.findMany({
      where: { status: { in: ['PAID', 'ACTIVE'] }, ...entityWhere },
      select: { currency: true, remainingAmount: true },
    }),
    prisma.auditLog.findMany({
      where: { ...auditScopeWhere(auth), action: { notIn: ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'VIEW_SENSITIVE', 'EXPORT'] } },
      select: { id: true, action: true, entityType: true, entityId: true, summary: true, actorLabel: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const counts = board?.counts ?? {};
  const outstanding = new Map<string, Money>();
  for (const advance of outstandingAdvances) {
    outstanding.set(advance.currency, (outstanding.get(advance.currency) ?? ZERO).plus(advance.remainingAmount));
  }

  const periodView = (period: (typeof periods)[number] | undefined) =>
    period
      ? {
          id: period.id,
          name: period.name,
          status: period.status,
          currency: period.currency,
          employeeCount: period.employeeCount,
          totalGross: toAmount(period.totalGross),
          totalNet: toAmount(period.totalNet),
          payDate: period.payDate ? toDateKey(period.payDate) : null,
        }
      : null;

  return {
    cards: {
      totalEmployees,
      presentToday: counts.present ?? 0,
      absentToday: counts.absent ?? 0,
      lateToday: counts.late ?? 0,
      notCheckedIn: counts.notCheckedIn ?? 0,
      onLeaveToday: counts.onLeave ?? 0,
      remoteEmployees,
      pendingLeaveRequests: pendingLeaveCount,
      pendingSalaryAdvances: pendingAdvanceCount,
      missingCheckouts: counts.missingCheckout ?? 0,
    },
    todayAttendance: board ? { counts, rows: board.rows.slice(0, 12), total: board.rows.length } : null,
    missingCheckouts: board?.missingCheckouts ?? [],
    pendingApprovals: {
      total: pendingLeaveCount + pendingOtherRequests + pendingAdvanceCount + pendingOvertimeCount + pendingAdjustmentCount,
      leaveRequests: pendingLeave.map((request) => ({
        id: request.id,
        reference: request.reference,
        submittedAt: request.submittedAt,
        employee: label(request.employee),
        leaveType: request.leaveDetail?.leaveType ?? null,
        startDate: request.leaveDetail ? toDateKey(request.leaveDetail.startDate) : null,
        endDate: request.leaveDetail ? toDateKey(request.leaveDetail.endDate) : null,
        workingDays: request.leaveDetail ? Number(request.leaveDetail.workingDays) : null,
      })),
      otherRequests: pendingOtherRequests,
      salaryAdvances: pendingAdvances.map((advance) => ({
        id: advance.id,
        reference: advance.reference,
        amount: toAmount(advance.requestedAmount),
        currency: advance.currency,
        requestedAt: advance.requestDate,
        employee: label(advance.employee),
      })),
      overtime: pendingOvertime.map((entry) => ({
        id: entry.id,
        date: toDateKey(entry.date),
        minutes: entry.minutes,
        employee: label(entry.employee),
      })),
      counts: {
        leaveRequests: pendingLeaveCount,
        otherRequests: pendingOtherRequests,
        salaryAdvances: pendingAdvanceCount,
        overtime: pendingOvertimeCount,
        payrollAdjustments: pendingAdjustmentCount,
        payrollAwaitingApproval: periods.filter((period) => period.status === 'REVIEWED').length,
      },
    },
    recentActivity,
    // Pay figures: this panel is only ever built for HR and administrators.
    payroll: {
      current: periodView(periods.find((period) => period.status !== 'PAID')),
      lastPaid: periodView(periods.find((period) => period.status === 'PAID')),
      awaitingApproval: periods.filter((period) => period.status === 'REVIEWED').map((period) => periodView(period)),
      outstandingAdvances: [...outstanding.entries()].map(([currency, value]) => ({ currency, amount: toAmount(value) })),
    },
  };
}

/** A line manager's team panel: today's attendance and the decisions waiting for them. */
export async function getManagerPanels(auth: AuthContext, now: Date = new Date()): Promise<Record<string, unknown> | null> {
  if (!auth.employeeId) return null;
  const teamSize = await prisma.employee.count({ where: { managerId: auth.employeeId, status: { not: 'OFFBOARDED' } } });
  if (teamSize === 0) return null;

  const [board, pendingLeave, pendingOvertime] = await Promise.all([
    boardOrNull(auth, now),
    prisma.request.findMany({
      where: { status: 'PENDING', employee: { managerId: auth.employeeId } },
      select: {
        id: true,
        reference: true,
        type: true,
        submittedAt: true,
        employee: { select: employeeLabelSelect },
        leaveDetail: { select: { startDate: true, endDate: true, workingDays: true, leaveType: { select: { name: true, colorHex: true } } } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 10,
    }),
    prisma.overtimeEntry.findMany({
      where: { status: 'PENDING', employee: { managerId: auth.employeeId } },
      select: { id: true, date: true, minutes: true, employee: { select: employeeLabelSelect } },
      orderBy: { date: 'asc' },
      take: 10,
    }),
  ]);

  const counts = board?.counts ?? {};
  return {
    teamSize,
    cards: {
      teamSize,
      presentToday: counts.present ?? 0,
      absentToday: counts.absent ?? 0,
      lateToday: counts.late ?? 0,
      notCheckedIn: counts.notCheckedIn ?? 0,
      onLeaveToday: counts.onLeave ?? 0,
      pendingApprovals: pendingLeave.length + pendingOvertime.length,
    },
    todayAttendance: board ? { counts, rows: board.rows } : null,
    missingCheckouts: board?.missingCheckouts ?? [],
    pendingApprovals: {
      requests: pendingLeave.map((request) => ({
        id: request.id,
        reference: request.reference,
        type: request.type,
        submittedAt: request.submittedAt,
        employee: label(request.employee),
        leaveType: request.leaveDetail?.leaveType ?? null,
        startDate: request.leaveDetail ? toDateKey(request.leaveDetail.startDate) : null,
        endDate: request.leaveDetail ? toDateKey(request.leaveDetail.endDate) : null,
        workingDays: request.leaveDetail ? Number(request.leaveDetail.workingDays) : null,
      })),
      // Minutes only: overtime amounts are pay data and never reach a manager.
      overtime: pendingOvertime.map((entry) => ({
        id: entry.id,
        date: toDateKey(entry.date),
        minutes: entry.minutes,
        employee: label(entry.employee),
      })),
    },
  };
}

/** The employee's own time and pay at a glance. */
export async function getSelfPanels(auth: AuthContext, now: Date = new Date()): Promise<Record<string, unknown>> {
  if (!auth.employeeId) return {};
  const employeeId = auth.employeeId;
  const context = await loadWorkContext(employeeId);
  const todayKey = zonedDateKey(now, context.timezone);

  const [attendanceToday, latestPayslip, advance, holidays] = await Promise.all([
    getMyToday(auth, now).catch(() => null),
    prisma.payrollRecord.findFirst({
      where: { employeeId, period: { status: { in: ['APPROVED', 'PAID'] } } },
      select: { id: true, netSalary: true, currency: true, payslipDocumentId: true, period: { select: { name: true, status: true, payDate: true } } },
      orderBy: [{ period: { year: 'desc' } }, { period: { month: 'desc' } }],
    }),
    prisma.salaryAdvance.findFirst({
      where: { employeeId, status: { in: ['PENDING', 'APPROVED', 'PAID', 'ACTIVE'] } },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        requestedAmount: true,
        approvedAmount: true,
        remainingAmount: true,
        installments: { where: { status: 'SCHEDULED' }, orderBy: { sequence: 'asc' }, take: 1, select: { dueMonth: true, amount: true } },
      },
      orderBy: { requestDate: 'desc' },
    }),
    // The employee's own calendar (a remote employee may follow another
    // country's holidays), recurring holidays included.
    loadHolidayDates([context.holidayCalendarId], todayKey, toDateKey(new Date(now.getTime() + 90 * 86_400_000))),
  ]);
  const holidayMap = context.holidayCalendarId ? holidays.get(context.holidayCalendarId) : undefined;

  const next = advance?.installments[0];
  return {
    attendanceToday,
    upcomingHolidays: [...(holidayMap?.entries() ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 5)
      .map(([date, holiday]) => ({ name: holiday.name, date })),
    pay: {
      latestPayslip: latestPayslip
        ? {
            recordId: latestPayslip.id,
            period: latestPayslip.period.name,
            status: latestPayslip.period.status,
            payDate: latestPayslip.period.payDate ? toDateKey(latestPayslip.period.payDate) : null,
            netSalary: toAmount(latestPayslip.netSalary),
            currency: latestPayslip.currency,
            hasPdf: Boolean(latestPayslip.payslipDocumentId),
          }
        : null,
      activeAdvance: advance
        ? {
            id: advance.id,
            reference: advance.reference,
            status: advance.status,
            currency: advance.currency,
            amount: toAmount(advance.approvedAmount ?? advance.requestedAmount),
            remainingAmount: ['PAID', 'ACTIVE'].includes(advance.status)
              ? toAmount(advance.remainingAmount)
              : toAmount(advance.approvedAmount ?? advance.requestedAmount),
            nextInstallment: next ? { dueMonth: toDateKey(next.dueMonth).slice(0, 7), amount: toAmount(next.amount) } : null,
          }
        : null,
    },
  };
}

/** Monthly salary cost per entity, in Decimal, never summed across currencies. */
export function monthlyCost(records: { baseSalary: Money; housingAllowance: Money; transportAllowance: Money; otherAllowances: Money; payFrequency: string }[]): Money {
  return sum(
    records.map((record) => {
      const total = record.baseSalary.plus(record.housingAllowance).plus(record.transportAllowance).plus(record.otherAllowances);
      if (record.payFrequency === 'ANNUAL') return total.dividedBy(12);
      if (record.payFrequency === 'BIWEEKLY') return total.times(26).dividedBy(12);
      return total;
    }),
  );
}
