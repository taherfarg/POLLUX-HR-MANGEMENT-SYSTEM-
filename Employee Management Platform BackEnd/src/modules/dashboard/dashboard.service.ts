import { prisma } from '../../db/prisma';
import type { AuthContext } from '../../common/auth-context';
import { entityScopeWhere, isManagement, scopedEntityId } from '../../services/access';
import { addDays, monthsBetween, startOfUtcDay } from '../../services/working-days';
import { getLeaveBalances } from '../leave/leave.service';
import { toAmount, type Money } from '../../services/money';
import { getManagementPanels, getManagerPanels, getSelfPanels, monthlyCost } from './pollux-dashboard.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return addDays(startOfUtcDay(new Date()), days);
}

/**
 * Headcount over the last twelve months.
 *
 * Computed in memory from hire and exit dates rather than in SQL. At prototype
 * scale the whole roster is a few hundred rows, and one readable pass beats a
 * window-function query nobody can modify with confidence. If the roster grew
 * past a few thousand this would move into a SQL generate_series.
 */
function buildHeadcountTrend(
  employees: { hireDate: Date; exitDate: Date | null }[],
  months = 12,
): { month: string; headcount: number }[] {
  const now = new Date();
  const trend: { month: string; headcount: number }[] = [];

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    // Last instant of the month, `offset` months back.
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0, 23, 59, 59));
    const headcount = employees.filter(
      (employee) =>
        employee.hireDate <= monthEnd && (employee.exitDate === null || employee.exitDate > monthEnd),
    ).length;
    trend.push({ month: monthEnd.toISOString().slice(0, 7), headcount });
  }

  return trend;
}

/** Next occurrence of a day/month, used for birthdays and work anniversaries. */
function nextAnniversary(source: Date, from: Date): Date {
  const candidate = new Date(Date.UTC(from.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
  return candidate < from ? new Date(Date.UTC(from.getUTCFullYear() + 1, source.getUTCMonth(), source.getUTCDate())) : candidate;
}

export async function getAdminDashboard(auth: AuthContext): Promise<Record<string, unknown>> {
  const scope = entityScopeWhere(auth);
  const today = startOfUtcDay(new Date());
  const activeWhere = { ...scope, status: { not: 'OFFBOARDED' as const } };

  const [
    entities,
    employeesForTrend,
    byStatus,
    byEntity,
    byDepartment,
    byEmploymentType,
    recentHires,
    recentExits,
    pendingByType,
    departments,
    onLeaveToday,
  ] = await Promise.all([
    prisma.legalEntity.findMany({
      where: scope.legalEntityId ? { id: scope.legalEntityId as string } : {},
      select: { id: true, code: true, name: true, countryCode: true, currency: true },
      orderBy: { name: 'asc' },
    }),
    prisma.employee.findMany({ where: scope, select: { hireDate: true, exitDate: true } }),
    prisma.employee.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ['legalEntityId'], where: activeWhere, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ['departmentId'], where: activeWhere, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ['employmentType'], where: activeWhere, _count: { _all: true } }),
    prisma.employee.count({ where: { ...scope, hireDate: { gte: daysFromNow(-30) } } }),
    prisma.employee.count({ where: { ...scope, exitDate: { gte: daysFromNow(-90) } } }),
    prisma.request.groupBy({
      by: ['type'],
      where: { status: 'PENDING', ...(scope.legalEntityId ? { legalEntityId: scope.legalEntityId as string } : {}) },
      _count: { _all: true },
    }),
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.leaveRequestDetail.count({
      where: {
        startDate: { lte: today },
        endDate: { gte: today },
        request: {
          status: 'APPROVED',
          ...(scope.legalEntityId ? { legalEntityId: scope.legalEntityId as string } : {}),
        },
      },
    }),
  ]);

  const departmentNames = new Map(departments.map((department) => [department.id, department.name]));
  const entityNames = new Map(entities.map((entity) => [entity.id, entity]));

  const activeEmployees = await prisma.employee.findMany({
    where: activeWhere,
    select: { hireDate: true },
  });
  const averageTenureMonths =
    activeEmployees.length === 0
      ? 0
      : Math.round(
          activeEmployees.reduce((total, employee) => total + monthsBetween(employee.hireDate, new Date()), 0) /
            activeEmployees.length,
        );

  const headcount = activeEmployees.length;

  return {
    headcount: {
      total: headcount,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      byLegalEntity: byEntity
        .map((row) => ({
          legalEntityId: row.legalEntityId,
          code: entityNames.get(row.legalEntityId)?.code ?? '',
          name: entityNames.get(row.legalEntityId)?.name ?? 'Unknown',
          countryCode: entityNames.get(row.legalEntityId)?.countryCode ?? '',
          headcount: row._count._all,
        }))
        .sort((a, b) => b.headcount - a.headcount),
      byDepartment: byDepartment
        .map((row) => ({
          departmentId: row.departmentId,
          name: row.departmentId ? (departmentNames.get(row.departmentId) ?? 'Unknown') : 'Unassigned',
          headcount: row._count._all,
        }))
        .sort((a, b) => b.headcount - a.headcount),
      byEmploymentType: Object.fromEntries(byEmploymentType.map((row) => [row.employmentType, row._count._all])),
    },
    movement: {
      hiresLast30Days: recentHires,
      exitsLast90Days: recentExits,
      averageTenureMonths,
      trend: buildHeadcountTrend(employeesForTrend),
    },
    requests: {
      pendingTotal: pendingByType.reduce((total, row) => total + row._count._all, 0),
      pendingByType: Object.fromEntries(pendingByType.map((row) => [row.type, row._count._all])),
    },
    absence: {
      onLeaveToday,
      // Share of the workforce away today - the number a manager actually acts on.
      onLeaveTodayPercent: headcount === 0 ? 0 : Number(((onLeaveToday / headcount) * 100).toFixed(1)),
    },
    legalEntities: entities,
  };
}

/**
 * Time-sensitive items that need someone to act.
 *
 * This is the piece of the brief about reminders: probation periods that lapse
 * silently, visas that expire, contracts that roll over. Each entry carries the
 * employee and a due date so the frontend can render one actionable list.
 */
export async function getManagementAlerts(auth: AuthContext): Promise<Record<string, unknown>> {
  const scope = entityScopeWhere(auth);
  const today = startOfUtcDay(new Date());

  const employeeSelect = {
    id: true,
    employeeNumber: true,
    firstName: true,
    lastName: true,
    jobTitle: true,
    avatarUrl: true,
    hireDate: true,
    legalEntity: { select: { id: true, code: true, name: true } },
  } as const;

  const [probationEnding, contractsEnding, expiringDocuments, staleRequests, anniversaryPool] = await Promise.all([
    prisma.employee.findMany({
      where: {
        ...scope,
        status: 'PROBATION',
        probationEndDate: { gte: today, lte: daysFromNow(30) },
      },
      select: { ...employeeSelect, probationEndDate: true },
      orderBy: { probationEndDate: 'asc' },
    }),
    prisma.employee.findMany({
      where: {
        ...scope,
        status: { not: 'OFFBOARDED' },
        // 90 days, not 60: the Saudi and Egyptian entities carry a 60-day notice
        // period, so a shorter window would surface a renewal too late to act on.
        contractEndDate: { gte: today, lte: daysFromNow(90) },
      },
      select: { ...employeeSelect, contractEndDate: true },
      orderBy: { contractEndDate: 'asc' },
    }),
    prisma.document.findMany({
      where: {
        expiresOn: { gte: today, lte: daysFromNow(90) },
        employee: scope.legalEntityId ? { legalEntityId: scope.legalEntityId as string } : {},
      },
      select: {
        id: true,
        title: true,
        category: true,
        expiresOn: true,
        employee: { select: employeeSelect },
      },
      orderBy: { expiresOn: 'asc' },
    }),
    // Anything pending for more than five days is being forgotten.
    prisma.request.findMany({
      where: {
        status: 'PENDING',
        submittedAt: { lte: daysFromNow(-5) },
        ...(scope.legalEntityId ? { legalEntityId: scope.legalEntityId as string } : {}),
      },
      select: {
        id: true,
        reference: true,
        type: true,
        submittedAt: true,
        employee: { select: employeeSelect },
      },
      orderBy: { submittedAt: 'asc' },
      take: 20,
    }),
    prisma.employee.findMany({
      where: { ...scope, status: { not: 'OFFBOARDED' } },
      select: { ...employeeSelect, dateOfBirth: true },
    }),
  ]);

  const horizon = daysFromNow(30);
  const withName = <T extends { firstName: string; lastName: string }>(employee: T) => ({
    ...employee,
    fullName: `${employee.firstName} ${employee.lastName}`,
  });

  const anniversaries = anniversaryPool
    .map((employee) => {
      const next = nextAnniversary(employee.hireDate, today);
      return {
        employee: withName(employee),
        date: next.toISOString().slice(0, 10),
        years: next.getUTCFullYear() - employee.hireDate.getUTCFullYear(),
        due: next,
      };
    })
    .filter((entry) => entry.years > 0 && entry.due <= horizon)
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .map(({ due: _due, ...entry }) => entry);

  const birthdays = anniversaryPool
    .filter((employee) => employee.dateOfBirth !== null)
    .map((employee) => {
      const next = nextAnniversary(employee.dateOfBirth as Date, today);
      return { employee: withName(employee), date: next.toISOString().slice(0, 10), due: next };
    })
    .filter((entry) => entry.due <= horizon)
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .map(({ due: _due, ...entry }) => entry);

  return {
    probationEnding: probationEnding.map((employee) => ({
      employee: withName(employee),
      date: employee.probationEndDate?.toISOString().slice(0, 10) ?? null,
      daysRemaining: employee.probationEndDate
        ? Math.ceil((employee.probationEndDate.getTime() - today.getTime()) / DAY_MS)
        : null,
    })),
    contractsEnding: contractsEnding.map((employee) => ({
      employee: withName(employee),
      date: employee.contractEndDate?.toISOString().slice(0, 10) ?? null,
      daysRemaining: employee.contractEndDate
        ? Math.ceil((employee.contractEndDate.getTime() - today.getTime()) / DAY_MS)
        : null,
    })),
    expiringDocuments: expiringDocuments.map((document) => ({
      documentId: document.id,
      title: document.title,
      category: document.category,
      employee: withName(document.employee),
      date: document.expiresOn?.toISOString().slice(0, 10) ?? null,
      daysRemaining: document.expiresOn
        ? Math.ceil((document.expiresOn.getTime() - today.getTime()) / DAY_MS)
        : null,
    })),
    staleRequests: staleRequests.map((request) => ({
      requestId: request.id,
      reference: request.reference,
      type: request.type,
      employee: withName(request.employee),
      submittedAt: request.submittedAt,
      daysWaiting: Math.floor((Date.now() - request.submittedAt.getTime()) / DAY_MS),
    })),
    upcomingAnniversaries: anniversaries,
    upcomingBirthdays: birthdays,
  };
}

/**
 * Salary cost, grouped by currency and never summed across them.
 *
 * A single "total payroll" number across currencies would be meaningless
 * without an FX rate, and inventing one would be worse than omitting it. All
 * arithmetic is Decimal; numbers appear only in the response.
 */
export async function getCompensationOverview(auth: AuthContext): Promise<Record<string, unknown>> {
  const scope = scopedEntityId(auth);

  const records = await prisma.compensationRecord.findMany({
    where: {
      isCurrent: true,
      employee: {
        status: { not: 'OFFBOARDED' },
        ...(scope ? { legalEntityId: scope } : {}),
      },
    },
    select: {
      baseSalary: true,
      housingAllowance: true,
      transportAllowance: true,
      otherAllowances: true,
      currency: true,
      payFrequency: true,
      employee: { select: { legalEntityId: true, legalEntity: { select: { code: true, name: true } } } },
    },
  });

  const byEntity = new Map<string, { legalEntityId: string; code: string; name: string; currency: string; rows: typeof records }>();
  for (const record of records) {
    // Keyed by entity and currency: a salary recorded in another currency is
    // its own line, never added to the entity's local-currency total.
    const key = `${record.employee.legalEntityId}:${record.currency}`;
    const bucket = byEntity.get(key) ?? {
      legalEntityId: record.employee.legalEntityId,
      code: record.employee.legalEntity.code,
      name: record.employee.legalEntity.name,
      currency: record.currency,
      rows: [],
    };
    bucket.rows.push(record);
    byEntity.set(key, bucket);
  }

  const median = (values: Money[]): Money | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a.comparedTo(b));
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] as Money).plus(sorted[middle] as Money).dividedBy(2)
      : (sorted[middle] as Money);
  };

  return {
    byLegalEntity: [...byEntity.values()].map((bucket) => {
      const monthly = monthlyCost(bucket.rows);
      return {
        legalEntityId: bucket.legalEntityId,
        code: bucket.code,
        name: bucket.name,
        currency: bucket.currency,
        employeesWithSalary: bucket.rows.length,
        monthlyCost: toAmount(monthly),
        annualCost: toAmount(monthly.times(12)),
        medianBaseSalary: toAmount(median(bucket.rows.map((row) => row.baseSalary))) ?? 0,
      };
    }),
    note: 'Figures are grouped by currency and are not converted or summed across currencies.',
  };
}

/** The employee's own home screen: balances, live requests, what is coming up. */
export async function getEmployeeDashboard(auth: AuthContext): Promise<Record<string, unknown>> {
  if (!auth.employeeId) {
    return { linkedEmployee: false };
  }

  const today = startOfUtcDay(new Date());
  const year = today.getUTCFullYear();

  const [balances, pendingRequests, upcomingLeave, unreadNotifications, upcomingHolidays, teamOnLeave] =
    await Promise.all([
      getLeaveBalances(auth.employeeId, year),
      prisma.request.findMany({
        where: { employeeId: auth.employeeId, status: 'PENDING' },
        select: { id: true, reference: true, type: true, submittedAt: true },
        orderBy: { submittedAt: 'desc' },
      }),
      prisma.leaveRequestDetail.findMany({
        where: {
          endDate: { gte: today },
          request: { employeeId: auth.employeeId, status: 'APPROVED' },
        },
        select: {
          startDate: true,
          endDate: true,
          workingDays: true,
          leaveType: { select: { name: true, colorHex: true } },
          request: { select: { id: true, reference: true } },
        },
        orderBy: { startDate: 'asc' },
        take: 5,
      }),
      prisma.notification.count({ where: { userId: auth.userId, isRead: false } }),
      auth.legalEntityId
        ? prisma.holiday.findMany({
            where: { legalEntityId: auth.legalEntityId, date: { gte: today, lte: daysFromNow(90) } },
            select: { name: true, date: true },
            orderBy: { date: 'asc' },
            take: 5,
          })
        : Promise.resolve([]),
      // Colleagues away today, so the employee knows who is unavailable.
      prisma.leaveRequestDetail.findMany({
        where: {
          startDate: { lte: today },
          endDate: { gte: today },
          request: {
            status: 'APPROVED',
            legalEntityId: auth.legalEntityId ?? undefined,
            employeeId: { not: auth.employeeId },
          },
        },
        select: {
          request: {
            select: { employee: { select: { id: true, firstName: true, lastName: true, jobTitle: true, avatarUrl: true } } },
          },
          endDate: true,
        },
        take: 10,
      }),
    ]);

  return {
    linkedEmployee: true,
    leaveBalances: balances,
    pendingRequests,
    upcomingLeave: upcomingLeave.map((leave) => ({
      requestId: leave.request.id,
      reference: leave.request.reference,
      leaveType: leave.leaveType,
      startDate: leave.startDate.toISOString().slice(0, 10),
      endDate: leave.endDate.toISOString().slice(0, 10),
      workingDays: Number(leave.workingDays),
      startsInDays: Math.ceil((leave.startDate.getTime() - today.getTime()) / DAY_MS),
    })),
    unreadNotifications,
    upcomingHolidays: upcomingHolidays.map((holiday) => ({
      name: holiday.name,
      date: holiday.date.toISOString().slice(0, 10),
    })),
    teamOnLeaveToday: teamOnLeave.map((entry) => ({
      employee: {
        ...entry.request.employee,
        fullName: `${entry.request.employee.firstName} ${entry.request.employee.lastName}`,
      },
      returnsOn: addDays(entry.endDate, 1).toISOString().slice(0, 10),
    })),
  };
}

/**
 * Routes the caller to the dashboard that matches their role.
 *
 *  MANAGEMENT  HR and administrators: company cards, today's attendance,
 *              approvals, alerts, recent activity and payroll.
 *  MANAGER     their own panels plus their team's attendance and approvals -
 *              never pay figures for anyone but themselves.
 *  EMPLOYEE    their own attendance, leave, requests, payslip and advance.
 */
export async function getDashboard(auth: AuthContext): Promise<Record<string, unknown>> {
  const now = new Date();
  if (isManagement(auth)) {
    const [overview, alerts, panels, self] = await Promise.all([
      getAdminDashboard(auth),
      getManagementAlerts(auth),
      getManagementPanels(auth, now),
      getSelfPanels(auth, now),
    ]);
    return { view: 'MANAGEMENT', ...overview, alerts, ...panels, self };
  }

  const [personal, self, team] = await Promise.all([
    getEmployeeDashboard(auth),
    getSelfPanels(auth, now),
    auth.role === 'MANAGER' ? getManagerPanels(auth, now) : Promise.resolve(null),
  ]);
  return { view: auth.role === 'MANAGER' ? 'MANAGER' : 'EMPLOYEE', ...personal, ...self, team };
}
