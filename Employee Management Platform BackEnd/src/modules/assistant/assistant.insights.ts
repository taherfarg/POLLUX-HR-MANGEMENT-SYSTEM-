import { prisma } from '../../db/prisma';
import { isManagement, scopedEntityId } from '../../services/access';
import { addDaysToKey, zonedDateKey } from '../../services/timezone';
import { getBoard, listAttendance } from '../attendance/attendance.service';
import { listRequests } from '../requests/requests.service';
import { runReport } from '../reports/reports.service';
import { listTasks } from '../tasks/tasks.service';
import { fullName } from '../employees/employee.serializer';
import { date, DEPARTMENT, filters, PERSON, reachWhere, resolvePerson, text, toolError, type AssistantTool, type ToolContext } from './assistant.shared';

/**
 * Tools that do the arithmetic, so the model does not have to: what needs
 * attention now, attendance rolled up by department or by day, one person's
 * working profile, and public holidays. Same rule as every other tool: run as
 * the person asking, within their reach, read-only.
 */

const DAY_MS = 86_400_000;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const dayKey = (value: Date) => value.toISOString().slice(0, 10);
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0);

async function officeToday(context: ToolContext): Promise<string> {
  const entity = context.auth.legalEntityId
    ? await prisma.legalEntity.findUnique({ where: { id: context.auth.legalEntityId }, select: { timezone: true } })
    : await prisma.legalEntity.findFirst({ select: { timezone: true }, orderBy: { createdAt: 'asc' } });
  return zonedDateKey(context.now, entity?.timezone ?? 'UTC');
}

/** Runs one part of a summary; a part the caller may not see is reported, not fatal. */
async function part<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    return toolError(error);
  }
}

export const INSIGHT_TOOLS: AssistantTool[] = [
  {
    name: 'attention_items',
    label: 'What needs attention',
    description:
      'Everything that needs action now, in one call: requests waiting more than 3 days, overtime waiting for a decision, people late 3+ times in the last 14 days, absences without leave in the last 7 days, open check-ins missing a check-out, overdue tasks, probation reviews due in 30 days, contracts ending in 90 days and (HR) documents expiring in 60 days. Use for "anything I should worry about?", a daily brief, or "what should I follow up on?".',
    forRole: 'ALL',
    parameters: { type: 'object', properties: {} },
    run: async (_args, context) => {
      const { auth, fingerprint, now } = context;
      const today = await officeToday(context);
      const reach = reachWhere(auth);
      const team = !isManagement(auth);
      const soon = (days: number) => new Date(Date.parse(`${addDaysToKey(today, days)}T00:00:00.000Z`));
      const todayDate = new Date(`${today}T00:00:00.000Z`);

      const [staleRequests, pendingOvertime, repeatedLateness, absences, board, overdueTasks, probation, contracts, documents] = await Promise.all([
        part(async () => {
          const { items } = await listRequests(auth, { status: 'PENDING', myTeamOnly: team, page: 1, pageSize: 100, sortBy: 'submittedAt', sortOrder: 'asc' });
          return items
            .filter((request) => now.getTime() - new Date(request.submittedAt as string).getTime() > 3 * DAY_MS)
            .map((request) => ({
              reference: request.reference,
              type: request.type,
              employee: (request.employee as { fullName: string }).fullName,
              waitingDays: Math.floor((now.getTime() - new Date(request.submittedAt as string).getTime()) / DAY_MS),
            }));
        }),
        part(async () => {
          const entries = await prisma.overtimeEntry.findMany({
            where: { status: 'PENDING', employee: { AND: [reach, team ? { managerId: auth.employeeId } : {}] } },
            select: { date: true, minutes: true, employee: { select: { firstName: true, lastName: true, preferredName: true } } },
            orderBy: { date: 'asc' },
            take: 50,
          });
          return entries.map((entry) => ({ employee: fullName(entry.employee), date: dayKey(entry.date), minutes: entry.minutes }));
        }),
        part(async () => {
          const report = await runReport(auth, 'late', { format: 'json', from: addDaysToKey(today, -13), to: today }, fingerprint, now);
          const counts = new Map<string, { times: number; minutes: number }>();
          for (const row of report.rows) {
            const name = String(row.employee);
            const entry = counts.get(name) ?? { times: 0, minutes: 0 };
            entry.times += 1;
            entry.minutes += num(row.lateMinutes);
            counts.set(name, entry);
          }
          return [...counts.entries()]
            .filter(([, entry]) => entry.times >= 3)
            .sort((a, b) => b[1].times - a[1].times)
            .map(([employee, entry]) => ({ employee, lateTimes: entry.times, lateMinutes: entry.minutes }));
        }),
        part(async () => {
          const report = await runReport(auth, 'absence', { format: 'json', from: addDaysToKey(today, -7), to: addDaysToKey(today, -1) }, fingerprint, now);
          return report.rows.map((row) => ({ employee: row.employee, date: row.date }));
        }),
        part(async () => {
          const result = (await getBoard(auth, {}, now)) as { counts: Record<string, number>; missingCheckouts: Record<string, unknown>[] };
          return {
            today: result.counts,
            missingCheckouts: result.missingCheckouts.map((entry) => ({
              employee: (entry.employee as { fullName: string } | undefined)?.fullName ?? null,
              date: entry.date,
            })),
          };
        }),
        part(async () => {
          const { items } = await listTasks(auth, { view: team ? 'team' : 'all', status: 'open', page: 1, pageSize: 100 });
          return items.filter((task) => task.isOverdue).map((task) => ({ title: task.title, assignee: task.assignee.fullName, dueDate: task.dueDate, priority: task.priority }));
        }),
        prisma.employee.findMany({
          where: { AND: [reach, { status: 'PROBATION', probationEndDate: { gte: todayDate, lte: soon(30) } }] },
          select: { firstName: true, lastName: true, preferredName: true, probationEndDate: true },
          orderBy: { probationEndDate: 'asc' },
        }),
        prisma.employee.findMany({
          where: { AND: [reach, { status: { not: 'OFFBOARDED' }, contractEndDate: { gte: todayDate, lte: soon(90) } }] },
          select: { firstName: true, lastName: true, preferredName: true, contractEndDate: true },
          orderBy: { contractEndDate: 'asc' },
        }),
        // Documents are HR's to see; a manager's summary leaves them out.
        isManagement(auth)
          ? prisma.document.findMany({
              where: {
                expiresOn: { gte: todayDate, lte: soon(60) },
                // `reach` already narrows a scoped HR admin to their entity.
                employee: { AND: [reach, { status: { not: 'OFFBOARDED' } }] },
              },
              select: { title: true, category: true, expiresOn: true, employee: { select: { firstName: true, lastName: true, preferredName: true } } },
              orderBy: { expiresOn: 'asc' },
              take: 30,
            })
          : Promise.resolve(null),
      ]);

      return {
        asOf: today,
        attendanceToday: 'error' in board ? board : board.today,
        missingCheckouts: 'error' in board ? board : board.missingCheckouts,
        requestsWaitingOver3Days: staleRequests,
        overtimeWaitingForDecision: pendingOvertime,
        lateThreeOrMoreTimesInLast14Days: repeatedLateness,
        absencesWithoutLeaveLast7Days: absences,
        overdueTasks,
        probationReviewsDueIn30Days: probation.map((person) => ({ employee: fullName(person), date: person.probationEndDate ? dayKey(person.probationEndDate) : null })),
        contractsEndingIn90Days: contracts.map((person) => ({ employee: fullName(person), date: person.contractEndDate ? dayKey(person.contractEndDate) : null })),
        ...(documents
          ? {
              documentsExpiringIn60Days: documents.map((document) => ({
                employee: fullName(document.employee),
                document: document.title,
                category: document.category,
                expiresOn: document.expiresOn ? dayKey(document.expiresOn) : null,
              })),
            }
          : {}),
      };
    },
  },
  {
    name: 'attendance_by_group',
    label: 'Attendance by group',
    description:
      'Attendance over a period (up to 93 days) rolled up per department, work location or work mode: people, working days, present, late, absent and leave days, punctuality % (on-time share of days present) and absence % (absent share of working days). Use for comparisons such as "which department is late most?".',
    forRole: 'ALL',
    parameters: {
      type: 'object',
      properties: {
        from: date('First day of the period'),
        to: date('Last day of the period, inclusive'),
        groupBy: { type: 'string', enum: ['department', 'workLocation', 'workMode'] },
      },
      required: ['from', 'to', 'groupBy'],
    },
    run: async (args, { auth, fingerprint, now }) => {
      try {
        const report = await runReport(auth, 'attendance', { format: 'json', from: text(args.from), to: text(args.to) }, fingerprint, now);
        const key = (['department', 'workLocation', 'workMode'] as const).find((value) => value === args.groupBy) ?? 'department';
        const groups = new Map<string, { people: number; working: number; present: number; late: number; absent: number; leave: number; lateMinutes: number }>();
        for (const row of report.rows) {
          const name = String(row[key] ?? 'Not set');
          const group = groups.get(name) ?? { people: 0, working: 0, present: 0, late: 0, absent: 0, leave: 0, lateMinutes: 0 };
          group.people += 1;
          group.working += num(row.scheduledDays);
          group.present += num(row.presentDays);
          group.late += num(row.lateDays);
          group.absent += num(row.absentDays);
          group.leave += num(row.leaveDays);
          group.lateMinutes += num(row.lateMinutes);
          groups.set(name, group);
        }
        return {
          period: report.subtitle,
          groupedBy: key,
          groups: [...groups.entries()]
            .map(([name, group]) => ({
              group: name,
              ...group,
              punctualityPercent: pct(group.present - group.late, group.present),
              absencePercent: pct(group.absent, group.working),
            }))
            .sort((a, b) => b.late - a.late),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  {
    name: 'attendance_by_day',
    label: 'Attendance by day',
    description:
      'Day-by-day attendance totals over a period of up to 31 days: how many were present, late, absent, on leave, and the average check-in time. Use for trends ("how was attendance each day this week?") and to find the worst day.',
    forRole: 'ALL',
    parameters: {
      type: 'object',
      properties: { from: date('First day'), to: date('Last day, inclusive'), department: DEPARTMENT },
      required: ['from', 'to'],
    },
    run: async (args, { auth, now }) => {
      const from = text(args.from);
      const to = text(args.to);
      if (from && to && Date.parse(to) - Date.parse(from) > 30 * DAY_MS) {
        return { error: 'Choose at most 31 days for a day-by-day view; use attendance_summary for longer periods.' };
      }
      const resolved = await filters(auth, args);
      if ('failed' in resolved) return resolved.failed;
      try {
        const { items } = await listAttendance(
          auth,
          { from, to, departmentId: resolved.result.departmentId, page: 1, pageSize: 5000, includeRestDays: false } as Parameters<typeof listAttendance>[1],
          now,
        );
        const days = new Map<string, { present: number; late: number; absent: number; onLeave: number; checkInMinutes: number[] }>();
        for (const item of items as Record<string, unknown>[]) {
          const day = days.get(String(item.date)) ?? { present: 0, late: 0, absent: 0, onLeave: 0, checkInMinutes: [] };
          const status = String(item.status);
          if (['PRESENT', 'LATE', 'PARTIAL', 'MISSING_CHECKOUT'].includes(status)) day.present += 1;
          if (num(item.lateMinutes) > 0) day.late += 1;
          if (status === 'ABSENT') day.absent += 1;
          if (status === 'ON_LEAVE') day.onLeave += 1;
          const clock = typeof item.checkInLocal === 'string' ? item.checkInLocal.match(/^(\d{2}):(\d{2})/) : null;
          if (clock) day.checkInMinutes.push(Number(clock[1]) * 60 + Number(clock[2]));
          days.set(String(item.date), day);
        }
        return {
          days: [...days.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, totals]) => {
              const average = totals.checkInMinutes.length
                ? Math.round(totals.checkInMinutes.reduce((sum, value) => sum + value, 0) / totals.checkInMinutes.length)
                : null;
              return {
                date: day,
                present: totals.present,
                late: totals.late,
                absent: totals.absent,
                onLeave: totals.onLeave,
                averageCheckIn: average === null ? null : `${String(Math.floor(average / 60)).padStart(2, '0')}:${String(average % 60).padStart(2, '0')}`,
              };
            }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  {
    name: 'employee_profile',
    label: 'Employee profile',
    description:
      'One person’s working profile: job title, department, manager, work location and mode, schedule, status, hire date and length of service, probation and contract end dates, and this year’s annual leave balance. No pay and no personal data.',
    forRole: 'ALL',
    parameters: { type: 'object', properties: { person: PERSON }, required: ['person'] },
    run: async (args, context) => {
      const name = text(args.person);
      if (!name) return { error: 'Say whose profile to look up.' };
      const found = await resolvePerson(context.auth, name);
      if ('error' in found) return found;
      const year = Number((await officeToday(context)).slice(0, 4));
      const person = await prisma.employee.findUniqueOrThrow({
        where: { id: found.id },
        select: {
          employeeNumber: true,
          firstName: true,
          lastName: true,
          preferredName: true,
          jobTitle: true,
          status: true,
          workMode: true,
          employmentType: true,
          hireDate: true,
          probationEndDate: true,
          contractEndDate: true,
          department: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true, preferredName: true } },
          workLocation: { select: { name: true } },
          workSchedule: { select: { name: true } },
          leaveBalances: {
            where: { year },
            select: { entitledDays: true, carriedOverDays: true, usedDays: true, pendingDays: true, leaveType: { select: { name: true } } },
          },
        },
      });
      const months = Math.max(0, Math.floor((context.now.getTime() - person.hireDate.getTime()) / (30.44 * DAY_MS)));
      return {
        name: fullName(person),
        employeeNumber: person.employeeNumber,
        jobTitle: person.jobTitle,
        department: person.department?.name ?? null,
        manager: person.manager ? fullName(person.manager) : null,
        status: person.status,
        employmentType: person.employmentType,
        workMode: person.workMode,
        workLocation: person.workLocation?.name ?? null,
        schedule: person.workSchedule?.name ?? 'Company default',
        hireDate: dayKey(person.hireDate),
        service: `${Math.floor(months / 12)} years ${months % 12} months`,
        probationEnds: person.probationEndDate ? dayKey(person.probationEndDate) : null,
        contractEnds: person.contractEndDate ? dayKey(person.contractEndDate) : null,
        leaveBalances: person.leaveBalances.map((balance) => {
          const entitled = Number(balance.entitledDays) + Number(balance.carriedOverDays);
          return {
            leaveType: balance.leaveType.name,
            entitled,
            used: Number(balance.usedDays),
            pending: Number(balance.pendingDays),
            available: Math.round((entitled - Number(balance.usedDays) - Number(balance.pendingDays)) * 100) / 100,
          };
        }),
      };
    },
  },
  {
    name: 'holidays',
    label: 'Public holidays',
    description: 'Public holidays between two dates, from the company holiday calendars, with the calendar each belongs to.',
    forRole: 'ALL',
    parameters: { type: 'object', properties: { from: date('First day'), to: date('Last day, inclusive') }, required: ['from', 'to'] },
    run: async (args, { auth }) => {
      const from = text(args.from);
      const to = text(args.to);
      if (!from || !to || to < from) return { error: 'Give a valid period: from and to as YYYY-MM-DD, from first.' };
      const entityId = scopedEntityId(auth) ?? auth.legalEntityId ?? undefined;
      const holidays = await prisma.holiday.findMany({
        where: {
          ...(entityId ? { legalEntityId: entityId } : {}),
          OR: [{ date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } }, { isRecurringAnnually: true }],
        },
        select: { name: true, date: true, isRecurringAnnually: true, calendar: { select: { name: true } } },
        orderBy: { date: 'asc' },
      });
      const found = [];
      for (const holiday of holidays) {
        const keys = holiday.isRecurringAnnually
          ? Array.from({ length: Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 1 }, (_, index) => `${Number(from.slice(0, 4)) + index}${dayKey(holiday.date).slice(4)}`)
          : [dayKey(holiday.date)];
        for (const key of keys) {
          if (key >= from && key <= to) found.push({ date: key, name: holiday.name, calendar: holiday.calendar.name });
        }
      }
      found.sort((a, b) => a.date.localeCompare(b.date));
      return { holidays: found };
    },
  },
];
