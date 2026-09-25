import { Prisma } from '@prisma/client';
import type { EmploymentEventType } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../common/http';
import { toUtcDate } from '../../common/validate';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanAssignRole,
  assertCanEditEmployee,
  assertEntityInScope,
  assertIsManagement,
  employeeCapabilities,
  employeeViewLevel,
  entityScopeWhere,
  isManagement,
  type EmployeeAccessSubject,
} from '../../services/access';
import { resolveLegalEntityId } from '../../services/company';
import { diffRecords, recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee } from '../../services/notification.service';
import { generateTemporaryPassword, hashPassword } from '../auth/password';
import {
  employeeDetailInclude,
  employeeListInclude,
  fullName,
  serializeEmployeeDetail,
  serializeEmployeeList,
  type EmployeeListRow,
} from './employee.serializer';
import type {
  ChangeStatusInput,
  CreateEmployeeInput,
  EmployeeQuery,
  UpdateEmployeeInput,
} from './employees.schema';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/** Minimal read used by authorization before any data is serialized. */
export async function loadAccessSubject(employeeId: string): Promise<EmployeeAccessSubject> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, legalEntityId: true, managerId: true },
  });
  if (!employee) {
    throw new NotFoundError('Employee');
  }
  return employee;
}

function buildOrderBy(query: EmployeeQuery): Prisma.EmployeeOrderByWithRelationInput[] {
  const direction = query.sortOrder;
  switch (query.sortBy) {
    case 'hireDate':
      return [{ hireDate: direction }, { lastName: 'asc' }];
    case 'jobTitle':
      return [{ jobTitle: direction }, { lastName: 'asc' }];
    case 'employeeNumber':
      return [{ employeeNumber: direction }];
    case 'status':
      return [{ status: direction }, { lastName: 'asc' }];
    default:
      return [{ lastName: direction }, { firstName: direction }];
  }
}

function buildWhere(auth: AuthContext, query: EmployeeQuery): Prisma.EmployeeWhereInput {
  const filters: Prisma.EmployeeWhereInput[] = [];

  // Entity scope is applied for everyone, so an HR_ADMIN pinned to one entity
  // cannot page past it and an employee's directory stays within the company.
  const scope = entityScopeWhere(auth);
  if (Object.keys(scope).length > 0) filters.push(scope);

  if (query.q) {
    const term = query.q;
    filters.push({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { preferredName: { contains: term, mode: 'insensitive' } },
        { employeeNumber: { contains: term, mode: 'insensitive' } },
        { workEmail: { contains: term, mode: 'insensitive' } },
        { jobTitle: { contains: term, mode: 'insensitive' } },
      ],
    });
  }

  if (query.legalEntityId) filters.push({ legalEntityId: query.legalEntityId });
  if (query.departmentId) filters.push({ departmentId: query.departmentId });
  if (query.managerId) filters.push({ managerId: query.managerId });
  if (query.workLocationId) filters.push({ workLocationId: query.workLocationId });
  if (query.workScheduleId) filters.push({ workScheduleId: query.workScheduleId });
  if (query.status?.length) filters.push({ status: { in: query.status } });
  if (query.employmentType?.length) filters.push({ employmentType: { in: query.employmentType } });
  if (query.workMode?.length) filters.push({ workMode: { in: query.workMode } });

  // An explicit status filter wins over the default "hide leavers" behaviour.
  if (!query.includeOffboarded && !query.status?.length) {
    filters.push({ status: { not: 'OFFBOARDED' } });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

export async function listEmployees(
  auth: AuthContext,
  query: EmployeeQuery,
): Promise<{ items: Record<string, unknown>[]; meta: PageMeta }> {
  const where = buildWhere(auth, query);
  const { skip, take } = toSkipTake(query);

  const [employees, total] = await Promise.all([
    prisma.employee.findMany({ where, include: employeeListInclude, orderBy: buildOrderBy(query), skip, take }),
    prisma.employee.count({ where }),
  ]);

  return {
    items: serializeEmployeeList(employees, auth),
    meta: buildPageMeta(query.page, query.pageSize, total),
  };
}

export async function getEmployee(auth: AuthContext, employeeId: string): Promise<Record<string, unknown>> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: employeeDetailInclude,
  });
  if (!employee) {
    throw new NotFoundError('Employee');
  }

  const level = employeeViewLevel(auth, employee);
  return serializeEmployeeDetail(employee, level, {
    includeAccount: isManagement(auth),
    capabilities: employeeCapabilities(auth, employee),
  });
}

/**
 * Employee numbers are readable and prefixed per company: PLX-0007, or the
 * entity country code (AE-0007) when no prefix is configured.
 *
 * The next value is derived from the highest existing number for that prefix
 * inside the creating transaction. Under a concurrent insert the unique
 * constraint rejects the duplicate and the caller retries - correctness comes
 * from the constraint, not from the read.
 */
async function nextEmployeeNumber(tx: TxClient, prefixSource: string): Promise<string> {
  const prefix = `${prefixSource.toUpperCase()}-`;
  const latest = await tx.employee.findFirst({
    where: { employeeNumber: { startsWith: prefix } },
    orderBy: { employeeNumber: 'desc' },
    select: { employeeNumber: true },
  });

  const lastSequence = latest ? Number.parseInt(latest.employeeNumber.slice(prefix.length), 10) : 0;
  const next = Number.isNaN(lastSequence) ? 1 : lastSequence + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/**
 * Seeds this year's leave balances from the entity's leave policy.
 *
 * Someone joining mid-year gets a pro-rated entitlement for the months they will
 * actually work, rounded to the nearest half day - the convention every HRIS we
 * looked at uses.
 */
async function seedLeaveBalances(
  tx: TxClient,
  employee: { id: string; legalEntityId: string; hireDate: Date; gender: string | null },
): Promise<void> {
  const year = new Date().getUTCFullYear();
  const leaveTypes = await tx.leaveType.findMany({
    where: {
      isActive: true,
      OR: [{ legalEntityId: employee.legalEntityId }, { legalEntityId: null }],
    },
  });

  const hireYear = employee.hireDate.getUTCFullYear();
  const monthsRemaining = hireYear === year ? 12 - employee.hireDate.getUTCMonth() : 12;

  const applicable = leaveTypes.filter(
    (type) => !type.restrictedToGender || type.restrictedToGender === employee.gender,
  );

  await tx.leaveBalance.createMany({
    data: applicable.map((type) => {
      const annual = Number(type.annualEntitlementDays);
      const prorated = Math.round(((annual * monthsRemaining) / 12) * 2) / 2;
      return {
        employeeId: employee.id,
        leaveTypeId: type.id,
        year,
        entitledDays: new Prisma.Decimal(prorated),
      };
    }),
    skipDuplicates: true,
  });
}

/**
 * Checks that the work location, schedule and holiday calendar an employee is
 * being pointed at exist, are active, and belong to the employee's company -
 * a schedule from another entity would silently apply the wrong policy.
 */
async function assertWorkContextReferences(
  legalEntityId: string,
  input: { workLocationId?: string | null; workScheduleId?: string | null; holidayCalendarId?: string | null },
): Promise<void> {
  const errors: Record<string, string[]> = {};

  if (input.workLocationId) {
    const location = await prisma.workLocation.findUnique({
      where: { id: input.workLocationId },
      select: { legalEntityId: true, isActive: true },
    });
    if (!location || location.legalEntityId !== legalEntityId || !location.isActive) {
      errors.workLocationId = ['Choose an active work location belonging to this company'];
    }
  }
  if (input.workScheduleId) {
    const schedule = await prisma.workSchedule.findUnique({
      where: { id: input.workScheduleId },
      select: { legalEntityId: true, isActive: true },
    });
    if (!schedule || schedule.legalEntityId !== legalEntityId || !schedule.isActive) {
      errors.workScheduleId = ['Choose an active work schedule belonging to this company'];
    }
  }
  if (input.holidayCalendarId) {
    const calendar = await prisma.holidayCalendar.findUnique({
      where: { id: input.holidayCalendarId },
      select: { legalEntityId: true, isActive: true },
    });
    if (!calendar || calendar.legalEntityId !== legalEntityId || !calendar.isActive) {
      errors.holidayCalendarId = ['Choose an active holiday calendar belonging to this company'];
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
}

export async function createEmployee(
  auth: AuthContext,
  input: CreateEmployeeInput,
  fingerprint: Fingerprint,
): Promise<{ employee: Record<string, unknown>; temporaryPassword?: string }> {
  assertIsManagement(auth);
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertEntityInScope(auth, legalEntityId);

  // Checked before anything is written: an HR admin must not be able to mint
  // an ADMIN login by creating an employee.
  if (input.account) {
    assertCanAssignRole(auth, input.account.role, input.account.scopedLegalEntityId ?? null);
    if (input.account.scopedLegalEntityId) assertEntityInScope(auth, input.account.scopedLegalEntityId);
  }

  const legalEntity = await prisma.legalEntity.findUnique({
    where: { id: legalEntityId },
    select: {
      id: true,
      countryCode: true,
      currency: true,
      probationMonths: true,
      noticePeriodDays: true,
      isActive: true,
      settings: { select: { employeeNumberPrefix: true } },
    },
  });
  if (!legalEntity) {
    throw new ValidationError('Validation failed', { legalEntityId: ['Legal entity does not exist'] });
  }
  if (!legalEntity.isActive) {
    throw new ValidationError('Validation failed', { legalEntityId: ['This legal entity is inactive'] });
  }

  if (input.managerId) {
    const manager = await prisma.employee.findUnique({
      where: { id: input.managerId },
      select: { id: true },
    });
    if (!manager) {
      throw new ValidationError('Validation failed', { managerId: ['Manager does not exist'] });
    }
  }

  if (input.departmentId) {
    const department = await prisma.department.findUnique({
      where: { id: input.departmentId },
      select: { id: true },
    });
    if (!department) {
      throw new ValidationError('Validation failed', { departmentId: ['Department does not exist'] });
    }
  }

  await assertWorkContextReferences(legalEntityId, input);

  const accountEmail = input.account ? (input.account.email ?? input.workEmail) : null;
  if (accountEmail) {
    const existing = await prisma.user.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (existing) {
      throw new ConflictError('A login already exists for this email address');
    }
  }

  const temporaryPassword = input.account
    ? (input.account.temporaryPassword ?? generateTemporaryPassword())
    : undefined;

  const hireDate = toUtcDate(input.hireDate);
  const probationEnd = input.probationEndDate
    ? toUtcDate(input.probationEndDate)
    : new Date(Date.UTC(hireDate.getUTCFullYear(), hireDate.getUTCMonth() + legalEntity.probationMonths, hireDate.getUTCDate()));

  const created = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({
      data: {
        employeeNumber: await nextEmployeeNumber(tx, legalEntity.settings?.employeeNumberPrefix ?? legalEntity.countryCode),
        firstName: input.firstName,
        lastName: input.lastName,
        preferredName: input.preferredName ?? null,
        workEmail: input.workEmail,
        personalEmail: input.personalEmail ?? null,
        phone: input.phone ?? null,
        dateOfBirth: input.dateOfBirth ? toUtcDate(input.dateOfBirth) : null,
        gender: input.gender ?? null,
        nationality: input.nationality ?? null,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        emergencyContactName: input.emergencyContactName ?? null,
        emergencyContactPhone: input.emergencyContactPhone ?? null,
        emergencyContactRelation: input.emergencyContactRelation ?? null,
        avatarUrl: input.avatarUrl ?? null,
        legalEntityId,
        departmentId: input.departmentId ?? null,
        managerId: input.managerId ?? null,
        jobTitle: input.jobTitle,
        employmentType: input.employmentType,
        contractType: input.contractType,
        workMode: input.workMode,
        status: input.status,
        hireDate,
        probationEndDate: probationEnd,
        contractEndDate: input.contractEndDate ? toUtcDate(input.contractEndDate) : null,
        noticePeriodDays: input.noticePeriodDays ?? legalEntity.noticePeriodDays,
        workLocationId: input.workLocationId ?? null,
        workScheduleId: input.workScheduleId ?? null,
        holidayCalendarId: input.holidayCalendarId ?? null,
        workCountryCode: input.workCountryCode ?? null,
        workCountry: input.workCountry ?? null,
        workCity: input.workCity ?? null,
        timezone: input.timezone ?? null,
        overtimeEligible: input.overtimeEligible ?? true,
        attendanceTracked: input.attendanceTracked ?? true,
      },
      include: employeeDetailInclude,
    });

    await tx.employmentEvent.create({
      data: {
        employeeId: employee.id,
        type: 'HIRED',
        effectiveDate: hireDate,
        title: `Joined as ${employee.jobTitle}`,
        description: `Hired into ${employee.legalEntity.name}`,
        newValue: { jobTitle: employee.jobTitle, legalEntity: employee.legalEntity.name },
        createdById: auth.userId,
      },
    });

    if (input.compensation) {
      await tx.compensationRecord.create({
        data: {
          employeeId: employee.id,
          effectiveFrom: input.compensation.effectiveFrom ? toUtcDate(input.compensation.effectiveFrom) : hireDate,
          baseSalary: new Prisma.Decimal(input.compensation.baseSalary),
          currency: input.compensation.currency ?? legalEntity.currency,
          payFrequency: input.compensation.payFrequency,
          housingAllowance: new Prisma.Decimal(input.compensation.housingAllowance),
          transportAllowance: new Prisma.Decimal(input.compensation.transportAllowance),
          otherAllowances: new Prisma.Decimal(input.compensation.otherAllowances),
          variablePayPercent: new Prisma.Decimal(input.compensation.variablePayPercent),
          changeReason: input.compensation.changeReason ?? 'Starting compensation',
          isCurrent: true,
          createdById: auth.userId,
        },
      });
    }

    await seedLeaveBalances(tx, employee);

    if (input.account && accountEmail && temporaryPassword) {
      await tx.user.create({
        data: {
          email: accountEmail,
          passwordHash: await hashPassword(temporaryPassword),
          role: input.account.role,
          employeeId: employee.id,
          scopedLegalEntityId: input.account.scopedLegalEntityId ?? null,
          mustChangePassword: true,
        },
      });
    }

    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'Employee',
        entityId: employee.id,
        legalEntityId: employee.legalEntityId,
        summary: `Created employee ${employee.employeeNumber} - ${fullName(employee)}`,
        after: {
          employeeNumber: employee.employeeNumber,
          jobTitle: employee.jobTitle,
          legalEntityId: employee.legalEntityId,
          status: employee.status,
        },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    // Re-read so the response includes the login that was just created; the
    // row loaded at insert time predates it.
    return input.account
      ? tx.employee.findUniqueOrThrow({ where: { id: employee.id }, include: employeeDetailInclude })
      : employee;
  });

  if (input.account) {
    await notifyEmployee(created.id, {
      type: 'WELCOME',
      title: 'Welcome to the team',
      body: 'Your employee profile is ready. Please change your temporary password from your profile settings.',
      entityType: 'Employee',
      entityId: created.id,
    });
  }

  return {
    employee: serializeEmployeeDetail(created, 'FULL', { includeAccount: true }),
    temporaryPassword,
  };
}

/**
 * Maps a field change to the timeline event it represents, so the employee's
 * history reads as business events rather than a column-by-column diff.
 */
function timelineEventsFor(
  before: EmployeeListRow,
  input: UpdateEmployeeInput,
): { type: EmploymentEventType; title: string; previous: unknown; next: unknown }[] {
  const events: { type: EmploymentEventType; title: string; previous: unknown; next: unknown }[] = [];

  if (input.jobTitle && input.jobTitle !== before.jobTitle) {
    events.push({
      type: 'PROMOTION',
      title: `Job title changed to ${input.jobTitle}`,
      previous: before.jobTitle,
      next: input.jobTitle,
    });
  }
  if (input.legalEntityId && input.legalEntityId !== before.legalEntityId) {
    events.push({
      type: 'TRANSFER',
      title: 'Transferred to another legal entity',
      previous: before.legalEntity.name,
      next: input.legalEntityId,
    });
  }
  if (input.managerId !== undefined && input.managerId !== before.managerId) {
    events.push({
      type: 'MANAGER_CHANGE',
      title: 'Reporting line updated',
      previous: before.managerId,
      next: input.managerId,
    });
  }
  if (input.contractEndDate && before.contractEndDate?.toISOString().slice(0, 10) !== input.contractEndDate) {
    events.push({
      type: 'CONTRACT_RENEWAL',
      title: `Contract end date set to ${input.contractEndDate}`,
      previous: before.contractEndDate,
      next: input.contractEndDate,
    });
  }
  // Where someone works is part of their employment story ("moved to remote,
  // Cairo"), so a change of work mode or location is a timeline event too.
  const locationChanged = input.workLocationId !== undefined && input.workLocationId !== before.workLocationId;
  const modeChanged = input.workMode !== undefined && input.workMode !== before.workMode;
  const cityChanged = input.workCity !== undefined && input.workCity !== before.workCity;
  if (locationChanged || modeChanged || cityChanged) {
    const mode = input.workMode ?? before.workMode;
    const city = input.workCity === undefined ? before.workCity : input.workCity;
    events.push({
      type: 'TRANSFER',
      title: `Work arrangement changed to ${mode.toLowerCase()}${city ? ` (${city})` : ''}`,
      previous: { workMode: before.workMode, workLocationId: before.workLocationId, workCity: before.workCity },
      next: {
        workMode: mode,
        workLocationId: input.workLocationId === undefined ? before.workLocationId : input.workLocationId,
        workCity: city,
      },
    });
  }

  return events;
}

export async function updateEmployee(
  auth: AuthContext,
  employeeId: string,
  input: UpdateEmployeeInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const existing = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: employeeDetailInclude,
  });
  if (!existing) {
    throw new NotFoundError('Employee');
  }

  assertCanEditEmployee(auth, existing);
  if (input.legalEntityId) {
    // Moving someone into an entity the caller cannot see would put the record
    // out of their own reach, so both sides of the move are checked.
    assertEntityInScope(auth, input.legalEntityId);
  }

  if (input.managerId && input.managerId === employeeId) {
    throw new ValidationError('Validation failed', { managerId: ['An employee cannot report to themselves'] });
  }

  if (input.managerId) {
    await assertNoReportingCycle(employeeId, input.managerId);
  }

  await assertWorkContextReferences(input.legalEntityId ?? existing.legalEntityId, input);

  const data: Prisma.EmployeeUpdateInput = {};
  const assign = <K extends keyof Prisma.EmployeeUpdateInput>(key: K, value: Prisma.EmployeeUpdateInput[K]): void => {
    if (value !== undefined) data[key] = value;
  };

  assign('firstName', input.firstName);
  assign('lastName', input.lastName);
  assign('preferredName', input.preferredName);
  assign('workEmail', input.workEmail);
  assign('personalEmail', input.personalEmail);
  assign('phone', input.phone);
  assign('gender', input.gender);
  assign('nationality', input.nationality);
  assign('addressLine', input.addressLine);
  assign('city', input.city);
  assign('country', input.country);
  assign('emergencyContactName', input.emergencyContactName);
  assign('emergencyContactPhone', input.emergencyContactPhone);
  assign('emergencyContactRelation', input.emergencyContactRelation);
  assign('avatarUrl', input.avatarUrl);
  assign('jobTitle', input.jobTitle);
  assign('employmentType', input.employmentType);
  assign('contractType', input.contractType);
  assign('workMode', input.workMode);
  assign('noticePeriodDays', input.noticePeriodDays);
  assign('workCountryCode', input.workCountryCode);
  assign('workCountry', input.workCountry);
  assign('workCity', input.workCity);
  assign('timezone', input.timezone);
  assign('overtimeEligible', input.overtimeEligible);
  assign('attendanceTracked', input.attendanceTracked);

  if (input.dateOfBirth) data.dateOfBirth = toUtcDate(input.dateOfBirth);
  if (input.hireDate) data.hireDate = toUtcDate(input.hireDate);
  if (input.probationEndDate) data.probationEndDate = toUtcDate(input.probationEndDate);
  if (input.contractEndDate) data.contractEndDate = toUtcDate(input.contractEndDate);
  if (input.legalEntityId) data.legalEntity = { connect: { id: input.legalEntityId } };
  if (input.departmentId !== undefined) {
    data.department = input.departmentId ? { connect: { id: input.departmentId } } : { disconnect: true };
  }
  if (input.managerId !== undefined) {
    data.manager = input.managerId ? { connect: { id: input.managerId } } : { disconnect: true };
  }
  if (input.workLocationId !== undefined) {
    data.workLocation = input.workLocationId ? { connect: { id: input.workLocationId } } : { disconnect: true };
  }
  if (input.workScheduleId !== undefined) {
    data.workSchedule = input.workScheduleId ? { connect: { id: input.workScheduleId } } : { disconnect: true };
  }
  if (input.holidayCalendarId !== undefined) {
    data.holidayCalendar = input.holidayCalendarId ? { connect: { id: input.holidayCalendarId } } : { disconnect: true };
  }

  const events = timelineEventsFor(existing, input);

  const updated = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.update({
      where: { id: employeeId },
      data,
      include: employeeDetailInclude,
    });

    for (const event of events) {
      await tx.employmentEvent.create({
        data: {
          employeeId,
          type: event.type,
          effectiveDate: new Date(),
          title: event.title,
          previousValue: event.previous === null ? Prisma.JsonNull : (event.previous as Prisma.InputJsonValue),
          newValue: event.next === null ? Prisma.JsonNull : (event.next as Prisma.InputJsonValue),
          createdById: auth.userId,
        },
      });
    }

    const diff = diffRecords(existing as unknown as Record<string, unknown>, data as Record<string, unknown>);
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'Employee',
        entityId: employeeId,
        legalEntityId: employee.legalEntityId,
        summary: `Updated employee ${existing.employeeNumber}`,
        before: diff?.before ?? null,
        after: diff?.after ?? null,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return employee;
  });

  return serializeEmployeeDetail(updated, 'FULL', { includeAccount: isManagement(auth) });
}

/**
 * Walks up the proposed reporting line to make sure the change does not create a
 * loop. A cycle would make the org chart and any manager-based permission check
 * recurse forever.
 */
async function assertNoReportingCycle(employeeId: string, proposedManagerId: string): Promise<void> {
  let cursor: string | null = proposedManagerId;
  const seen = new Set<string>([employeeId]);

  while (cursor) {
    if (seen.has(cursor)) {
      throw new ValidationError('Validation failed', {
        managerId: ['This reporting line would create a cycle'],
      });
    }
    seen.add(cursor);
    const next: { managerId: string | null } | null = await prisma.employee.findUnique({
      where: { id: cursor },
      select: { managerId: true },
    });
    cursor = next?.managerId ?? null;
  }
}

export async function changeEmployeeStatus(
  auth: AuthContext,
  employeeId: string,
  input: ChangeStatusInput,
  fingerprint: Fingerprint,
): Promise<Record<string, unknown>> {
  const existing = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: employeeDetailInclude,
  });
  if (!existing) {
    throw new NotFoundError('Employee');
  }
  assertCanEditEmployee(auth, existing);

  if (existing.status === input.status) {
    throw new ConflictError(`Employee is already ${input.status}`);
  }

  const effectiveDate = toUtcDate(input.effectiveDate);
  const isOffboarding = input.status === 'OFFBOARDED';

  const updated = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.update({
      where: { id: employeeId },
      data: {
        status: input.status,
        exitDate: isOffboarding ? effectiveDate : null,
        exitReason: isOffboarding ? (input.exitReason ?? null) : null,
      },
      include: employeeDetailInclude,
    });

    await tx.employmentEvent.create({
      data: {
        employeeId,
        type: isOffboarding
          ? 'OFFBOARDED'
          : input.status === 'ACTIVE' && existing.status === 'PROBATION'
            ? 'PROBATION_COMPLETED'
            : 'STATUS_CHANGE',
        effectiveDate,
        title: `Status changed from ${existing.status} to ${input.status}`,
        description: input.reason,
        previousValue: { status: existing.status },
        newValue: { status: input.status },
        createdById: auth.userId,
      },
    });

    if (isOffboarding) {
      // A leaver must not keep an active login, and pending sessions are ended
      // immediately rather than at token expiry.
      await tx.user.updateMany({ where: { employeeId }, data: { isActive: false } });
      await tx.refreshToken.updateMany({
        where: { user: { employeeId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'Employee',
        entityId: employeeId,
        legalEntityId: existing.legalEntityId,
        summary: `Status changed ${existing.status} to ${input.status}: ${input.reason}`,
        before: { status: existing.status },
        after: { status: input.status, effectiveDate: input.effectiveDate },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return employee;
  });

  return serializeEmployeeDetail(updated, 'FULL', { includeAccount: true });
}

/**
 * The employee's history in one ordered feed: employment events, decided
 * requests and - where the caller is allowed to see them - compensation changes.
 */
export async function getEmployeeTimeline(
  employeeId: string,
  options: { includeCompensation: boolean },
): Promise<Record<string, unknown>[]> {
  const [events, requests, compensation] = await Promise.all([
    prisma.employmentEvent.findMany({ where: { employeeId }, orderBy: { effectiveDate: 'desc' } }),
    prisma.request.findMany({
      where: { employeeId, status: { in: ['APPROVED', 'REJECTED'] } },
      orderBy: { decidedAt: 'desc' },
      take: 25,
      select: { id: true, reference: true, type: true, status: true, decidedAt: true, submittedAt: true },
    }),
    options.includeCompensation
      ? prisma.compensationRecord.findMany({
          where: { employeeId },
          orderBy: { effectiveFrom: 'desc' },
          select: { id: true, effectiveFrom: true, baseSalary: true, currency: true, changeReason: true },
        })
      : Promise.resolve([]),
  ]);

  const entries = [
    ...events.map((event) => ({
      id: event.id,
      kind: 'EMPLOYMENT_EVENT' as const,
      type: event.type,
      title: event.title,
      description: event.description,
      date: event.effectiveDate,
    })),
    ...requests.map((request) => ({
      id: request.id,
      kind: 'REQUEST' as const,
      type: request.type,
      title: `${request.reference} ${request.status.toLowerCase()}`,
      description: null,
      date: request.decidedAt ?? request.submittedAt,
    })),
    ...compensation.map((record) => ({
      id: record.id,
      kind: 'COMPENSATION' as const,
      type: 'COMPENSATION_CHANGE',
      title: record.changeReason,
      description: `${record.currency} ${Number(record.baseSalary).toLocaleString()}`,
      date: record.effectiveFrom,
    })),
  ];

  entries.sort((a, b) => b.date.getTime() - a.date.getTime());
  return entries;
}

export async function getDirectReports(employeeId: string, auth: AuthContext): Promise<Record<string, unknown>[]> {
  const reports = await prisma.employee.findMany({
    where: { managerId: employeeId, status: { not: 'OFFBOARDED' } },
    include: employeeListInclude,
    orderBy: [{ lastName: 'asc' }],
  });
  return serializeEmployeeList(reports, auth);
}
