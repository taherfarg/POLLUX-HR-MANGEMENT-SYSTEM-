import { Prisma } from '@prisma/client';
import type { AttendanceRecord, AttendanceStatus, WorkMode } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../common/http';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanManageAttendance,
  assertCanViewAttendance,
  entityScopeWhere,
  isManagement,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee } from '../../services/notification.service';
import { assertPayrollPeriodOpen } from '../../services/payroll-lock';
import { clockToMinutes, minutesBetween, zonedClock, zonedDateKey, zonedWallTimeToUtc } from '../../services/timezone';
import { loadWorkContext, type EmployeeWorkContext } from '../../services/work-context';
import { toDateKey } from '../../services/working-days';
import { syncOvertimeFromAttendance } from '../overtime/overtime.service';
import { evaluateDay, MAX_SHIFT_MINUTES, persistableStatus, type DayEvaluation, type DayPlan } from './attendance.engine';
import {
  attendancePolicy,
  freshPlan,
  loadAttendanceDays,
  loadDayInputs,
  serializeDay,
  snapshotPlan,
  totalsFor,
  type AttendanceDay,
  type EmployeeLabel,
} from './attendance.days';
import type {
  AttendanceListQuery,
  BoardQuery,
  CorrectAttendanceInput,
  ManualAttendanceInput,
  RecalculateInput,
  SummaryQuery,
  TimesheetQuery,
} from './attendance.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const MAX_RANGE_DAYS = 93;

function requireSelf(auth: AuthContext): string {
  if (!auth.employeeId) {
    throw new ForbiddenError('This account is not linked to an employee record');
  }
  return auth.employeeId;
}

/** Defaults to the current month to date; refuses reversed or oversized ranges. */
export function resolveRange(from: string | undefined, to: string | undefined, now: Date = new Date()): { fromKey: string; toKey: string } {
  const today = now.toISOString().slice(0, 10);
  const fromKey = from ?? `${today.slice(0, 7)}-01`;
  const toKey = to ?? (from ? addDays(fromKey, 30) : today);
  if (toKey < fromKey) {
    throw new ValidationError('Validation failed', { to: ['The end date cannot be before the start date'] });
  }
  const days = Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError('Validation failed', { to: [`Choose a range of at most ${MAX_RANGE_DAYS} days`] });
  }
  return { fromKey, toKey };
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Record fields written from a plan and its evaluation. */
function metricsData(plan: DayPlan, evaluation: DayEvaluation) {
  return {
    dayType: plan.dayType,
    scheduleId: plan.scheduleId,
    scheduledStart: plan.scheduledStart,
    scheduledEnd: plan.scheduledEnd,
    scheduledMinutes: plan.scheduledMinutes,
    breakMinutes: evaluation.breakMinutes,
    workedMinutes: evaluation.workedMinutes,
    lateMinutes: evaluation.lateMinutes,
    earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
    overtimeMinutes: evaluation.overtimeMinutes,
    absentDays: new Prisma.Decimal(evaluation.absentDays),
    status: persistableStatus(evaluation.status),
  };
}

async function planForDate(context: EmployeeWorkContext, dateKey: string, timezone?: string): Promise<DayPlan> {
  const inputs = (await loadDayInputs([context], dateKey, dateKey)).get(context.employeeId);
  if (!inputs) throw new NotFoundError('Employee');
  return freshPlan(context, inputs, dateKey, timezone);
}

function dayFromRecord(context: EmployeeWorkContext, plan: DayPlan, record: AttendanceRecord, evaluation: DayEvaluation): AttendanceDay {
  return { context, plan, record, evaluation };
}

// ---------------------------------------------------------------------------
// Self-service: check in, check out, today
// ---------------------------------------------------------------------------

/**
 * Checks the caller in. The server clock is the only clock that counts - a
 * client can say where it is checking in from, never when.
 */
export async function checkIn(
  auth: AuthContext,
  input: { notes?: string; source: 'WEB' | 'MOBILE' },
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const employeeId = requireSelf(auth);
  const context = await loadWorkContext(employeeId);
  const todayKey = zonedDateKey(now, context.timezone);

  if (todayKey < context.hireDateKey) {
    throw new ValidationError('Validation failed', { date: [`Your employment starts on ${context.hireDateKey}`] });
  }
  if (context.exitDateKey && todayKey > context.exitDateKey) {
    throw new ForbiddenError('Your employment has ended');
  }

  const plan = await planForDate(context, todayKey);
  if (plan.dayType === 'LEAVE') {
    throw new ConflictError(
      `You are on approved ${plan.leave?.leaveTypeName ?? 'leave'} today. Withdraw or change that leave with HR before checking in.`,
    );
  }
  await assertPayrollPeriodOpen(prisma, context.legalEntityId, todayKey);

  const existing = await prisma.attendanceRecord.findUnique({
    where: { employeeId_workDate: { employeeId, workDate: new Date(`${todayKey}T00:00:00.000Z`) } },
  });
  if (existing?.checkIn) {
    throw new ConflictError(
      existing.checkOut
        ? 'You have already checked in and out today'
        : `You are already checked in since ${zonedClock(existing.checkIn, existing.timezone)}`,
    );
  }
  if (existing) {
    throw new ConflictError('HR has already recorded attendance for today. Please contact HR.');
  }

  const evaluation = evaluateDay(plan, { checkIn: now, checkOut: null, statusOverride: null }, attendancePolicy(context.settings), {
    overtimeEligible: context.overtimeEligible,
    now,
    todayKey,
  });

  const record = await prisma.attendanceRecord.create({
    data: {
      employeeId,
      legalEntityId: context.legalEntityId,
      workDate: new Date(`${todayKey}T00:00:00.000Z`),
      timezone: plan.timezone,
      checkIn: now,
      checkInSource: input.source,
      source: input.source,
      notes: input.notes ?? null,
      ...metricsData(plan, evaluation),
    },
  });

  return serializeDay(dayFromRecord(context, plan, record, evaluation), { includeCorrection: true });
}

/**
 * Checks the caller out of their open check-in. A check-in more than a shift
 * old is refused rather than paired with today's check-out; HR corrects it.
 */
export async function checkOut(
  auth: AuthContext,
  input: { notes?: string; source: 'WEB' | 'MOBILE' },
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const employeeId = requireSelf(auth);
  const context = await loadWorkContext(employeeId);

  const open = await prisma.attendanceRecord.findFirst({
    where: { employeeId, checkIn: { not: null }, checkOut: null },
    orderBy: { workDate: 'desc' },
  });
  if (!open || !open.checkIn) {
    throw new ConflictError('You have not checked in today');
  }
  const workDateKey = toDateKey(open.workDate);
  if (minutesBetween(open.checkIn, now) > MAX_SHIFT_MINUTES) {
    throw new ConflictError(
      `Your check-in on ${workDateKey} has no check-out and is too old to close now. Ask HR to correct it.`,
    );
  }
  await assertPayrollPeriodOpen(prisma, open.legalEntityId, workDateKey);

  const plan = snapshotPlan(await planForDate(context, workDateKey, open.timezone), open);
  const evaluation = evaluateDay(
    plan,
    { checkIn: open.checkIn, checkOut: now, statusOverride: open.statusOverridden ? open.status : null },
    attendancePolicy(context.settings),
    { overtimeEligible: context.overtimeEligible, now, todayKey: zonedDateKey(now, open.timezone) },
  );

  const record = await prisma.$transaction(async (tx) => {
    const updated = await tx.attendanceRecord.update({
      where: { id: open.id },
      data: {
        checkOut: now,
        checkOutSource: input.source,
        notes: input.notes ?? open.notes,
        ...metricsData(plan, evaluation),
        // The plan snapshot taken at check-in stays authoritative.
        dayType: open.dayType,
        scheduledStart: open.scheduledStart,
        scheduledEnd: open.scheduledEnd,
        scheduledMinutes: open.scheduledMinutes,
      },
    });
    await syncOvertimeFromAttendance(tx, { record: updated, settings: context.settings });
    return updated;
  });

  return serializeDay(dayFromRecord(context, plan, record, evaluation), { includeCorrection: true });
}

/** The caller's attendance state right now, for the check-in card. */
export async function getMyToday(auth: AuthContext, now: Date = new Date()): Promise<Record<string, unknown>> {
  const employeeId = requireSelf(auth);
  const context = await loadWorkContext(employeeId);
  const todayKey = zonedDateKey(now, context.timezone);
  const loaded = (await loadAttendanceDays([employeeId], todayKey, todayKey, now)).get(employeeId);
  const today = loaded?.days[0];

  // A check-in still open from an earlier day - the reason a check-out might go
  // to yesterday's record, or be refused.
  const open = await prisma.attendanceRecord.findFirst({
    where: { employeeId, checkIn: { not: null }, checkOut: null, workDate: { lt: new Date(`${todayKey}T00:00:00.000Z`) } },
    orderBy: { workDate: 'desc' },
  });

  const record = today?.record ?? null;
  const onLeave = today?.plan.dayType === 'LEAVE';
  const canCheckOut = Boolean(
    (record?.checkIn && !record.checkOut) || (open?.checkIn && minutesBetween(open.checkIn, now) <= MAX_SHIFT_MINUTES),
  );
  // Before the company starts tracking, check-ins are recorded but a missing
  // one is not held against anyone - "not tracked yet", not "not tracked for you".
  const start = context.settings.attendanceStartDate ? toDateKey(context.settings.attendanceStartDate) : null;
  const trackingStartsOn = context.attendanceTracked && start && todayKey < start ? start : null;

  return {
    serverTime: now,
    timezone: context.timezone,
    localDate: todayKey,
    localTime: zonedClock(now, context.timezone),
    schedule: { id: context.schedule.id, name: context.schedule.name, timezone: context.schedule.timezone },
    today: today ? serializeDay(today, { includeCorrection: true }) : null,
    openFromEarlierDay: open ? { id: open.id, date: toDateKey(open.workDate), checkInLocal: zonedClock(open.checkIn, open.timezone) } : null,
    trackingStartsOn,
    canCheckIn: !record && !onLeave && !canCheckOut,
    canCheckOut,
  };
}

// ---------------------------------------------------------------------------
// Who may be listed
// ---------------------------------------------------------------------------

const subjectSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  workMode: true,
  legalEntityId: true,
  managerId: true,
  department: { select: { id: true, name: true } },
  workLocation: { select: { id: true, name: true } },
} as const;

export type SubjectRow = Prisma.EmployeeGetPayload<{ select: typeof subjectSelect }>;

export function labelOf(subject: SubjectRow): EmployeeLabel {
  return {
    id: subject.id,
    employeeNumber: subject.employeeNumber,
    fullName: `${subject.firstName} ${subject.lastName}`,
    jobTitle: subject.jobTitle,
    department: subject.department,
    workMode: subject.workMode,
    workLocation: subject.workLocation,
  };
}

/**
 * The employees whose attendance the caller may list, employed at some point
 * in the range: everyone in scope for HR, self plus direct reports for anyone
 * else. Filters narrow that set; they can never widen it.
 */
export async function resolveSubjects(
  auth: AuthContext,
  filters: { employeeId?: string; departmentId?: string; workLocationId?: string; workMode?: string; q?: string; teamOnly?: boolean },
  fromKey: string,
  toKey: string,
): Promise<SubjectRow[]> {
  const where: Prisma.EmployeeWhereInput[] = [
    { hireDate: { lte: new Date(`${toKey}T00:00:00.000Z`) } },
    { OR: [{ exitDate: null }, { exitDate: { gte: new Date(`${fromKey}T00:00:00.000Z`) } }] },
  ];

  if (isManagement(auth) && !filters.teamOnly) {
    const scope = entityScopeWhere(auth);
    if (Object.keys(scope).length > 0) where.push(scope);
  } else if (auth.employeeId) {
    where.push(
      filters.teamOnly
        ? { managerId: auth.employeeId }
        : { OR: [{ id: auth.employeeId }, { managerId: auth.employeeId }] },
    );
  } else {
    return [];
  }

  if (filters.employeeId) where.push({ id: filters.employeeId });
  if (filters.departmentId) where.push({ departmentId: filters.departmentId });
  if (filters.workLocationId) where.push({ workLocationId: filters.workLocationId });
  if (filters.workMode) where.push({ workMode: filters.workMode as WorkMode });
  if (filters.q) {
    where.push({
      OR: [
        { firstName: { contains: filters.q, mode: 'insensitive' } },
        { lastName: { contains: filters.q, mode: 'insensitive' } },
        { employeeNumber: { contains: filters.q, mode: 'insensitive' } },
      ],
    });
  }

  return prisma.employee.findMany({ where: { AND: where }, select: subjectSelect, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Attendance register: one row per employee per day, newest first. */
export async function listAttendance(
  auth: AuthContext,
  query: AttendanceListQuery,
  now: Date = new Date(),
): Promise<{ items: unknown[]; meta: PageMeta; totals: unknown }> {
  const { fromKey, toKey } = resolveRange(query.from, query.to, now);
  const subjects = await resolveSubjects(auth, query, fromKey, toKey);
  const loaded = await loadAttendanceDays(
    subjects.map((subject) => subject.id),
    fromKey,
    toKey,
    now,
  );

  const rows: { day: AttendanceDay; subject: SubjectRow }[] = [];
  for (const subject of subjects) {
    for (const day of loaded.get(subject.id)?.days ?? []) {
      if (day.evaluation.status === 'NOT_EMPLOYED') continue;
      if (!query.includeRestDays && !day.record && (day.plan.dayType === 'WEEKEND' || day.plan.dayType === 'HOLIDAY')) continue;
      // Future days, and days nobody was expected to record, carry no
      // information in a register.
      if ((day.evaluation.status === 'SCHEDULED' || day.evaluation.status === 'NOT_TRACKED') && !day.record) continue;
      if (query.status && !query.status.includes(day.evaluation.status as (typeof query.status)[number])) continue;
      rows.push({ day, subject });
    }
  }

  rows.sort((a, b) => b.day.plan.dateKey.localeCompare(a.day.plan.dateKey) || a.subject.firstName.localeCompare(b.subject.firstName));

  const { skip, take } = toSkipTake(query);
  const canCorrect = isManagement(auth);
  return {
    items: rows.slice(skip, skip + take).map(({ day, subject }) =>
      serializeDay(day, { employee: labelOf(subject), includeCorrection: canCorrect || subject.id === auth.employeeId }),
    ),
    meta: buildPageMeta(query.page, query.pageSize, rows.length),
    totals: totalsFor(rows.map((row) => row.day)),
  };
}

/** One employee's days and totals for a range - the timesheet and calendar view. */
export async function getTimesheet(auth: AuthContext, query: TimesheetQuery, now: Date = new Date()): Promise<unknown> {
  const employeeId = query.employeeId ?? requireSelf(auth);
  const subject = await prisma.employee.findUnique({ where: { id: employeeId }, select: subjectSelect });
  if (!subject) throw new NotFoundError('Employee');
  assertCanViewAttendance(auth, subject);

  const { fromKey, toKey } = resolveRange(query.from, query.to, now);
  const loaded = (await loadAttendanceDays([employeeId], fromKey, toKey, now)).get(employeeId);
  const days = loaded?.days ?? [];
  const includeCorrection = isManagement(auth) || employeeId === auth.employeeId;

  return {
    employee: labelOf(subject),
    from: fromKey,
    to: toKey,
    timezone: loaded?.context.timezone ?? null,
    schedule: loaded ? { id: loaded.context.schedule.id, name: loaded.context.schedule.name } : null,
    days: days.map((day) => serializeDay(day, { includeCorrection })),
    totals: totalsFor(days),
  };
}

/** Per-employee totals for a range - the timesheets overview. */
export async function getAttendanceSummary(auth: AuthContext, query: SummaryQuery, now: Date = new Date()): Promise<unknown> {
  const { fromKey, toKey } = resolveRange(query.from, query.to, now);
  const subjects = await resolveSubjects(auth, query, fromKey, toKey);
  const loaded = await loadAttendanceDays(
    subjects.map((subject) => subject.id),
    fromKey,
    toKey,
    now,
  );

  const rows = subjects.map((subject) => ({
    employee: labelOf(subject),
    timezone: loaded.get(subject.id)?.context.timezone ?? null,
    totals: totalsFor(loaded.get(subject.id)?.days ?? []),
  }));

  return { from: fromKey, to: toKey, rows, totals: totalsFor([...loaded.values()].flatMap((entry) => entry.days)) };
}

/**
 * Today at a glance, each employee in their own timezone's today: who is in,
 * late, not yet checked in, on leave or off - plus check-ins left open.
 */
export async function getBoard(auth: AuthContext, query: BoardQuery, now: Date = new Date()): Promise<unknown> {
  const management = isManagement(auth);
  const todayUtc = now.toISOString().slice(0, 10);
  // A day either side covers every timezone's "today".
  const fromKey = addDays(todayUtc, -1);
  const toKey = addDays(todayUtc, 1);

  const subjects = await resolveSubjects(auth, { ...query, teamOnly: !management }, fromKey, toKey);
  if (!management && subjects.length === 0) {
    throw new ForbiddenError('The attendance board is for managers and HR');
  }

  const loaded = await loadAttendanceDays(
    subjects.map((subject) => subject.id),
    fromKey,
    toKey,
    now,
  );

  const counts = {
    total: 0,
    present: 0,
    late: 0,
    notCheckedIn: 0,
    absent: 0,
    onLeave: 0,
    off: 0,
    remote: 0,
    checkedOut: 0,
    missingCheckout: 0,
  };

  const rows = [];
  for (const subject of subjects) {
    const entry = loaded.get(subject.id);
    const today = entry?.days.find((day) => day.plan.dateKey === entry.todayKey);
    if (!entry || !today || today.evaluation.status === 'NOT_EMPLOYED') continue;

    counts.total += 1;
    if (subject.workMode === 'REMOTE') counts.remote += 1;
    const status = today.evaluation.status;
    if (status === 'PRESENT' || status === 'LATE' || status === 'PARTIAL' || status === 'MISSING_CHECKOUT') counts.present += 1;
    if (today.evaluation.lateMinutes > 0) counts.late += 1;
    if (status === 'NOT_CHECKED_IN') counts.notCheckedIn += 1;
    if (status === 'ABSENT') counts.absent += 1;
    if (status === 'ON_LEAVE' || today.plan.leave) counts.onLeave += 1;
    if (status === 'WEEKEND' || status === 'HOLIDAY') counts.off += 1;
    if (today.record?.checkOut) counts.checkedOut += 1;

    rows.push(serializeDay(today, { employee: labelOf(subject), includeCorrection: management }));
  }

  // Open check-ins that have run past their shift, from the last week.
  const openRecords = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: { in: subjects.map((subject) => subject.id) },
      checkIn: { not: null },
      checkOut: null,
      workDate: { gte: new Date(`${addDays(todayUtc, -7)}T00:00:00.000Z`) },
    },
    orderBy: { workDate: 'desc' },
  });
  const bySubject = new Map(subjects.map((subject) => [subject.id, subject]));
  const missingCheckouts = [];
  for (const record of openRecords) {
    const entry = loaded.get(record.employeeId);
    const subject = bySubject.get(record.employeeId);
    if (!entry || !subject) continue;
    const plan = snapshotPlan(freshPlanFromLoaded(entry.context, record), record);
    const evaluation = evaluateDay(
      plan,
      { checkIn: record.checkIn, checkOut: null, statusOverride: record.statusOverridden ? record.status : null },
      attendancePolicy(entry.context.settings),
      { overtimeEligible: entry.context.overtimeEligible, now, todayKey: entry.todayKey },
    );
    if (evaluation.status !== 'MISSING_CHECKOUT') continue;
    missingCheckouts.push({
      recordId: record.id,
      date: toDateKey(record.workDate),
      checkInLocal: zonedClock(record.checkIn, record.timezone),
      timezone: record.timezone,
      employee: labelOf(subject),
    });
  }
  counts.missingCheckout = missingCheckouts.length;

  const statusOrder = ['NOT_CHECKED_IN', 'ABSENT', 'LATE', 'MISSING_CHECKOUT', 'PARTIAL', 'PRESENT', 'SCHEDULED', 'NOT_TRACKED', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND'];
  rows.sort(
    (a, b) =>
      statusOrder.indexOf(String(a.status)) - statusOrder.indexOf(String(b.status)) ||
      String((a.employee as EmployeeLabel).fullName).localeCompare(String((b.employee as EmployeeLabel).fullName)),
  );

  return { generatedAt: now, counts, rows, missingCheckouts };
}

/** A plan for an arbitrary stored record without another round of queries. */
function freshPlanFromLoaded(context: EmployeeWorkContext, record: AttendanceRecord): DayPlan {
  return {
    dateKey: toDateKey(record.workDate),
    dayOfWeek: record.workDate.getUTCDay(),
    timezone: record.timezone,
    dayType: record.dayType,
    isEmployed: true,
    holidayName: null,
    leave: null,
    halfLeave: false,
    scheduleId: record.scheduleId,
    scheduledStart: record.scheduledStart,
    scheduledEnd: record.scheduledEnd,
    scheduledMinutes: record.scheduledMinutes,
    breakMinutes: record.breakMinutes,
    restDayBreakMinutes: context.schedule.days.find((day) => day.isWorkingDay)?.breakMinutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// HR: create, correct, recalculate
// ---------------------------------------------------------------------------

function snapshotForAudit(record: AttendanceRecord) {
  return {
    checkIn: zonedClock(record.checkIn, record.timezone),
    checkOut: zonedClock(record.checkOut, record.timezone),
    status: record.status,
    statusOverridden: record.statusOverridden,
    workedMinutes: record.workedMinutes,
    lateMinutes: record.lateMinutes,
    earlyLeaveMinutes: record.earlyLeaveMinutes,
    overtimeMinutes: record.overtimeMinutes,
    notes: record.notes,
  };
}

function toInstant(dateKey: string, clock: string, timezone: string): Date {
  return zonedWallTimeToUtc(dateKey, clockToMinutes(clock), timezone);
}

async function loadSubjectForManagement(auth: AuthContext, employeeId: string) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true, firstName: true, lastName: true },
  });
  if (!employee) throw new NotFoundError('Employee');
  assertCanManageAttendance(auth, employee);
  return employee;
}

/** HR enters a day that has no record - a forgotten check-in, a field day. */
export async function createManualAttendance(
  auth: AuthContext,
  input: ManualAttendanceInput,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const employee = await loadSubjectForManagement(auth, input.employeeId);
  const context = await loadWorkContext(employee.id);

  if (input.date < context.hireDateKey || (context.exitDateKey && input.date > context.exitDateKey)) {
    throw new ValidationError('Validation failed', { date: ['The employee was not employed on this date'] });
  }
  await assertPayrollPeriodOpen(prisma, context.legalEntityId, input.date);

  const workDate = new Date(`${input.date}T00:00:00.000Z`);
  const existing = await prisma.attendanceRecord.findUnique({
    where: { employeeId_workDate: { employeeId: employee.id, workDate } },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError('This day already has an attendance record - correct it instead');
  }

  const plan = await planForDate(context, input.date);
  const checkInAt = input.checkIn ? toInstant(input.date, input.checkIn, plan.timezone) : null;
  const checkOutAt = input.checkOut ? toInstant(input.date, input.checkOut, plan.timezone) : null;
  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    throw new ValidationError('Validation failed', { checkOut: ['The check-out must be after the check-in'] });
  }

  const evaluation = evaluateDay(
    plan,
    { checkIn: checkInAt, checkOut: checkOutAt, statusOverride: input.status ?? null },
    attendancePolicy(context.settings),
    { overtimeEligible: context.overtimeEligible, now, todayKey: zonedDateKey(now, plan.timezone) },
  );

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.attendanceRecord.create({
      data: {
        employeeId: employee.id,
        legalEntityId: context.legalEntityId,
        workDate,
        timezone: plan.timezone,
        checkIn: checkInAt,
        checkOut: checkOutAt,
        checkInSource: checkInAt ? 'MANUAL' : null,
        checkOutSource: checkOutAt ? 'MANUAL' : null,
        source: 'MANUAL',
        notes: input.notes ?? null,
        isManual: true,
        statusOverridden: Boolean(input.status),
        correctedById: auth.userId,
        correctedAt: now,
        correctionReason: input.reason,
        ...metricsData(plan, evaluation),
        ...(input.status ? { status: input.status } : {}),
      },
    });
    if (created.checkOut) await syncOvertimeFromAttendance(tx, { record: created, settings: context.settings });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'AttendanceRecord',
        entityId: created.id,
        legalEntityId: context.legalEntityId,
        summary: `Recorded attendance for ${employee.employeeNumber} on ${input.date}: ${input.reason}`,
        after: snapshotForAudit(created),
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return created;
  });

  await notifyEmployee(employee.id, {
    type: 'ATTENDANCE_UPDATED',
    title: `Attendance recorded for ${input.date}`,
    body: input.reason,
    entityType: 'AttendanceRecord',
    entityId: record.id,
  });

  return serializeDay(dayFromRecord(context, plan, record, evaluation), { includeCorrection: true });
}

/**
 * HR corrects a recorded day. Times are read in the record's own timezone, the
 * day is re-evaluated against the current schedule, overtime follows, and the
 * before/after goes to the audit trail.
 */
export async function correctAttendance(
  auth: AuthContext,
  recordId: string,
  input: CorrectAttendanceInput,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const existing = await prisma.attendanceRecord.findUnique({ where: { id: recordId } });
  if (!existing) throw new NotFoundError('Attendance record');
  const employee = await loadSubjectForManagement(auth, existing.employeeId);
  const dateKey = toDateKey(existing.workDate);
  await assertPayrollPeriodOpen(prisma, existing.legalEntityId, dateKey);

  const context = await loadWorkContext(employee.id);
  const checkInAt =
    input.checkIn === undefined ? existing.checkIn : input.checkIn === null ? null : toInstant(dateKey, input.checkIn, existing.timezone);
  const checkOutAt =
    input.checkOut === undefined ? existing.checkOut : input.checkOut === null ? null : toInstant(dateKey, input.checkOut, existing.timezone);
  const override: AttendanceStatus | null =
    input.status === undefined ? (existing.statusOverridden ? existing.status : null) : input.status;

  if (checkOutAt && !checkInAt) {
    throw new ValidationError('Validation failed', { checkOut: ['A check-out needs a check-in'] });
  }
  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    throw new ValidationError('Validation failed', { checkOut: ['The check-out must be after the check-in'] });
  }
  if (!checkInAt && !override) {
    throw new ValidationError('Validation failed', { checkIn: ['A record without a check-in needs a status'] });
  }

  const plan = await planForDate(context, dateKey, existing.timezone);
  const evaluation = evaluateDay(
    plan,
    { checkIn: checkInAt, checkOut: checkOutAt, statusOverride: override },
    attendancePolicy(context.settings),
    { overtimeEligible: context.overtimeEligible, now, todayKey: zonedDateKey(now, existing.timezone) },
  );

  const record = await prisma.$transaction(async (tx) => {
    const updated = await tx.attendanceRecord.update({
      where: { id: recordId },
      data: {
        checkIn: checkInAt,
        checkOut: checkOutAt,
        checkInSource: input.checkIn !== undefined && checkInAt ? 'MANUAL' : existing.checkInSource,
        checkOutSource: input.checkOut !== undefined && checkOutAt ? 'MANUAL' : existing.checkOutSource,
        notes: input.notes === undefined ? existing.notes : input.notes,
        isManual: true,
        statusOverridden: Boolean(override),
        correctedById: auth.userId,
        correctedAt: now,
        correctionReason: input.reason,
        ...metricsData(plan, evaluation),
        ...(override ? { status: override } : {}),
      },
    });
    await syncOvertimeFromAttendance(tx, { record: updated, settings: context.settings });
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'AttendanceRecord',
        entityId: recordId,
        legalEntityId: existing.legalEntityId,
        summary: `Corrected attendance for ${employee.employeeNumber} on ${dateKey}: ${input.reason}`,
        before: snapshotForAudit(existing),
        after: snapshotForAudit(updated),
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return updated;
  });

  await notifyEmployee(employee.id, {
    type: 'ATTENDANCE_UPDATED',
    title: `Your attendance for ${dateKey} was corrected`,
    body: input.reason,
    entityType: 'AttendanceRecord',
    entityId: recordId,
  });

  return serializeDay(dayFromRecord(context, plan, record, evaluation), { includeCorrection: true });
}

/**
 * Re-applies the current schedule, holidays, leave and policy to completed
 * records in a range - after a schedule change, a late leave approval or a new
 * grace period. Explicit and audited, because it rewrites stored figures.
 * Dates inside an approved or paid payroll are skipped.
 */
export async function recalculateAttendance(
  auth: AuthContext,
  input: RecalculateInput,
  fingerprint: Fingerprint,
  now: Date = new Date(),
): Promise<{ examined: number; updated: number; skippedLocked: number }> {
  const { fromKey, toKey } = resolveRange(input.from, input.to, now);
  if (!isManagement(auth)) throw new ForbiddenError('Only HR can recalculate attendance');

  const subjects = await resolveSubjects(auth, { employeeId: input.employeeId }, fromKey, toKey);
  const records = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: { in: subjects.map((subject) => subject.id) },
      workDate: { gte: new Date(`${fromKey}T00:00:00.000Z`), lte: new Date(`${toKey}T00:00:00.000Z`) },
      checkOut: { not: null },
    },
  });

  const lockedPeriods = await prisma.payrollPeriod.findMany({
    where: { status: { in: ['APPROVED', 'PAID'] }, startDate: { lte: new Date(`${toKey}T00:00:00.000Z`) }, endDate: { gte: new Date(`${fromKey}T00:00:00.000Z`) } },
    select: { legalEntityId: true, startDate: true, endDate: true },
  });
  const isLocked = (record: AttendanceRecord) =>
    lockedPeriods.some(
      (period) => period.legalEntityId === record.legalEntityId && record.workDate >= period.startDate && record.workDate <= period.endDate,
    );

  let updated = 0;
  let skippedLocked = 0;
  const contexts = new Map<string, EmployeeWorkContext>();

  for (const record of records) {
    if (isLocked(record)) {
      skippedLocked += 1;
      continue;
    }
    const context = contexts.get(record.employeeId) ?? (await loadWorkContext(record.employeeId));
    contexts.set(record.employeeId, context);
    const dateKey = toDateKey(record.workDate);
    const plan = await planForDate(context, dateKey, record.timezone);
    const evaluation = evaluateDay(
      plan,
      { checkIn: record.checkIn, checkOut: record.checkOut, statusOverride: record.statusOverridden ? record.status : null },
      attendancePolicy(context.settings),
      { overtimeEligible: context.overtimeEligible, now, todayKey: zonedDateKey(now, record.timezone) },
    );
    const data = metricsData(plan, evaluation);
    const changed =
      data.workedMinutes !== record.workedMinutes ||
      data.lateMinutes !== record.lateMinutes ||
      data.earlyLeaveMinutes !== record.earlyLeaveMinutes ||
      data.overtimeMinutes !== record.overtimeMinutes ||
      data.scheduledMinutes !== record.scheduledMinutes ||
      data.status !== record.status ||
      data.dayType !== record.dayType;
    if (!changed) continue;

    await prisma.$transaction(async (tx) => {
      const saved = await tx.attendanceRecord.update({
        where: { id: record.id },
        data: { ...data, ...(record.statusOverridden ? { status: record.status } : {}) },
      });
      await syncOvertimeFromAttendance(tx, { record: saved, settings: context.settings });
    });
    updated += 1;
  }

  await recordAudit({
    action: 'UPDATE',
    entityType: 'AttendanceRecord',
    entityId: input.employeeId ?? null,
    legalEntityId: input.employeeId ? (subjects[0]?.legalEntityId ?? null) : null,
    summary: `Recalculated attendance ${fromKey} to ${toKey}: ${updated} of ${records.length} record(s) changed (${input.reason})`,
    after: { from: fromKey, to: toKey, examined: records.length, updated, skippedLocked },
    actor: auth,
    ...fingerprint,
  });

  return { examined: records.length, updated, skippedLocked };
}
