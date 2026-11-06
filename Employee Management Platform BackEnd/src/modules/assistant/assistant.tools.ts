import { prisma } from '../../db/prisma';
import type { AuthContext } from '../../common/auth-context';
import { isManagement } from '../../services/access';
import { getBoard } from '../attendance/attendance.service';
import { listRequests } from '../requests/requests.service';
import { runReport, type ReportType } from '../reports/reports.service';
import { listTasks } from '../tasks/tasks.service';
import { fullName } from '../employees/employee.serializer';
import { ACTION_TOOLS } from './assistant.actions';
import { INSIGHT_TOOLS } from './assistant.insights';
import { compactReport, date, DEPARTMENT, filters, MAX_ROWS, PERSON, text, toolError, type AssistantTool } from './assistant.shared';

/**
 * What the assistant can look up, and how.
 *
 * Every tool reads through a service the app already uses - the reports, the
 * attendance board, the request inbox, the task list - called as the person
 * asking. So the assistant can never see more than that person could on their
 * own pages: a manager's questions reach their direct reports only, an
 * entity-scoped HR admin's reach their entity only.
 * Nothing here writes: the action tools only prepare a change for the person
 * to confirm on the page.
 *
 * Pay is deliberately out of reach: there is no payroll, payslip, salary or
 * advance tool, so no amount is ever sent to the model.
 */

function reportTool(
  name: string,
  label: string,
  type: ReportType,
  description: string,
  extra: { status?: string[]; year?: boolean; range?: boolean } = {},
): AssistantTool {
  const properties: Record<string, unknown> = { person: PERSON, department: DEPARTMENT };
  const required: string[] = [];
  if (extra.range !== false) {
    properties.from = date('First day of the period');
    properties.to = date('Last day of the period, inclusive');
    required.push('from', 'to');
  }
  if (extra.year) properties.year = { type: 'integer', description: 'Calendar year, e.g. 2026. Leave out for this year.' };
  if (extra.status) properties.status = { type: 'string', enum: extra.status, description: 'Only entries with this status.' };

  return {
    name,
    label,
    description,
    forRole: type === 'employees' ? 'MANAGEMENT' : 'ALL',
    parameters: { type: 'object', properties, required },
    run: async (args, { auth, fingerprint, now }) => {
      const resolved = await filters(auth, args);
      if ('failed' in resolved) return resolved.failed;
      try {
        const document = await runReport(
          auth,
          type,
          {
            format: 'json',
            from: text(args.from),
            to: text(args.to),
            year: typeof args.year === 'number' ? args.year : undefined,
            status: text(args.status),
            ...resolved.result,
          },
          fingerprint,
          now,
        );
        return compactReport(document);
      } catch (error) {
        return toolError(error);
      }
    },
  };
}

const minutes = (value: unknown) => (typeof value === 'number' && value > 0 ? value : null);

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: 'attendance_today',
    label: 'Attendance today',
    description:
      'Live attendance right now, today only: each person with their status (PRESENT, LATE, NOT_CHECKED_IN, ABSENT, ON_LEAVE, WEEKEND, HOLIDAY, PARTIAL, MISSING_CHECKOUT), check-in and check-out times in their own timezone, minutes late and worked, plus counts and open check-ins missing a check-out from the past week. For any other day use attendance_summary or the other reports.',
    forRole: 'ALL',
    parameters: { type: 'object', properties: { department: DEPARTMENT } },
    run: async (args, { auth, now }) => {
      const resolved = await filters(auth, args);
      if ('failed' in resolved) return resolved.failed;
      try {
        const board = (await getBoard(auth, { departmentId: resolved.result.departmentId }, now)) as {
          counts: Record<string, number>;
          rows: Record<string, unknown>[];
          missingCheckouts: Record<string, unknown>[];
        };
        return {
          counts: board.counts,
          people: board.rows.slice(0, MAX_ROWS).map((row) => {
            const employee = row.employee as { fullName: string; jobTitle?: string; department?: { name: string } | null };
            const leave = row.leave as { leaveTypeName: string } | null;
            return {
              name: employee.fullName,
              jobTitle: employee.jobTitle ?? null,
              department: employee.department?.name ?? null,
              date: row.date,
              status: row.status,
              checkIn: row.checkInLocal,
              checkOut: row.checkOutLocal,
              scheduledStart: row.scheduledStartLocal,
              lateMinutes: minutes(row.lateMinutes),
              workedMinutes: minutes(row.workedMinutes),
              leave: leave?.leaveTypeName ?? null,
              holiday: row.holidayName ?? null,
            };
          }),
          missingCheckouts: board.missingCheckouts.map((entry) => {
            const employee = entry.employee as { fullName: string } | undefined;
            return { name: employee?.fullName ?? null, date: entry.date, checkIn: entry.checkInLocal ?? null };
          }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  reportTool(
    'attendance_summary',
    'Attendance report',
    'attendance',
    'Attendance per person over a period of up to 93 days: days present, late, absent and on leave, worked hours and overtime. Use from = to for a single past day.',
  ),
  reportTool('late_arrivals', 'Late arrivals report', 'late', 'Every late arrival in a period: who, which day, scheduled start, check-in and minutes late.'),
  reportTool('absences', 'Absence report', 'absence', 'Every working day in a period that someone neither checked in nor had approved leave.'),
  reportTool(
    'leave',
    'Leave report',
    'leave',
    'Leave requests overlapping a period: who, leave type, first and last day, working days and status. Use status APPROVED for "who took leave" / "who is on leave".',
    { status: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
  ),
  reportTool(
    'leave_balances',
    'Leave balance report',
    'leave-balance',
    'Leave balances for a year per person and leave type: entitlement, carried over, used, pending and available days.',
    { year: true, range: false },
  ),
  reportTool(
    'overtime',
    'Overtime report',
    'overtime',
    'Overtime entries in a period: who, day, minutes, rate multiplier and approval status. Minutes only - no amounts.',
    { status: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
  ),
  reportTool(
    'employee_list',
    'Employee report',
    'employees',
    'The employee list: number, name, job title, department, manager, work location, work mode, status and hire date. No pay data.',
    { range: false, status: ['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'OFFBOARDED'] },
  ),
  {
    name: 'my_team',
    label: 'My team',
    description: 'The people who report directly to the person asking: name, job title, department, work mode and status.',
    forRole: 'ALL',
    parameters: { type: 'object', properties: {} },
    run: async (_args, { auth }) => {
      if (!auth.employeeId) return { team: [] };
      const team = await prisma.employee.findMany({
        where: { managerId: auth.employeeId, status: { not: 'OFFBOARDED' } },
        select: { firstName: true, lastName: true, preferredName: true, jobTitle: true, workMode: true, status: true, department: { select: { name: true } } },
        orderBy: [{ firstName: 'asc' }],
      });
      return {
        team: team.map((person) => ({
          name: fullName(person),
          jobTitle: person.jobTitle,
          department: person.department?.name ?? null,
          workMode: person.workMode,
          status: person.status,
        })),
      };
    },
  },
  {
    name: 'pending_approvals',
    label: 'Requests waiting for a decision',
    description:
      'Leave, document and profile-change requests waiting for a decision that the person asking can see (for a manager: their team). Pending overtime is in the overtime tool with status PENDING.',
    forRole: 'ALL',
    parameters: { type: 'object', properties: {} },
    run: async (_args, { auth }) => {
      try {
        const { items, meta } = await listRequests(auth, {
          status: 'PENDING',
          myTeamOnly: !isManagement(auth),
          page: 1,
          pageSize: 100,
          sortBy: 'submittedAt',
          sortOrder: 'asc',
        });
        return {
          total: meta.total,
          requests: items.map((request) => {
            const employee = request.employee as { fullName: string } | undefined;
            const leave = request.leave as { leaveType?: { name?: string }; startDate: string; endDate: string; workingDays: number } | undefined;
            const document = request.document as { title?: string } | undefined;
            return {
              reference: request.reference,
              type: request.type,
              employee: employee?.fullName ?? null,
              submittedAt: request.submittedAt,
              ...(leave ? { leaveType: leave.leaveType?.name ?? null, startDate: leave.startDate, endDate: leave.endDate, workingDays: leave.workingDays } : {}),
              ...(document ? { document: document.title ?? null } : {}),
            };
          }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  {
    name: 'tasks',
    label: 'Tasks',
    description:
      'Tasks with assignee, priority, due date, status and whether overdue. view: "mine" (given to the person asking), "created" (given by them), "team" (given to their direct reports), "all" (everyone - HR only). status "open" means to do or in progress.',
    forRole: 'ALL',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['mine', 'created', 'team', 'all'] },
        status: { type: 'string', enum: ['open', 'all', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] },
      },
      required: ['view'],
    },
    run: async (args, { auth }) => {
      try {
        const view = (['mine', 'created', 'team', 'all'] as const).find((value) => value === args.view) ?? 'mine';
        const status = (['open', 'all', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const).find((value) => value === args.status) ?? 'open';
        const { items, summary, meta } = await listTasks(auth, { view, status, page: 1, pageSize: 100 });
        return {
          summary,
          total: meta.total,
          tasks: items.map((task) => ({
            title: task.title,
            assignee: task.assignee.fullName,
            from: task.createdBy?.fullName ?? null,
            priority: task.priority,
            status: task.status,
            dueDate: task.dueDate,
            overdue: task.isOverdue,
            comments: task.commentCount,
          })),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  ...INSIGHT_TOOLS,
  ...ACTION_TOOLS,
];

/** The tools offered to this caller. */
export function toolsFor(auth: AuthContext): AssistantTool[] {
  return ASSISTANT_TOOLS.filter((tool) => tool.forRole === 'ALL' || isManagement(auth));
}
