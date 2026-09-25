import type { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { emailSchema, optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanAssignRole,
  assertEntityInScope,
  assertIsManagement,
  isAdmin,
  managesEmployee,
  scopedEntityId,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { generateTemporaryPassword, hashPassword, passwordSchema } from '../auth/password';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Users & Roles: the logins behind employee records.
 *
 * The rules that keep this from being a privilege-escalation tool:
 *  - granting ADMIN or HR_ADMIN is for an ADMIN only (assertCanAssignRole);
 *  - an HR admin cannot touch an ADMIN or HR_ADMIN account at all - resetting
 *    an administrator's password would hand the HR admin that account;
 *  - a scoped HR admin only manages logins of employees in their entity;
 *  - nobody changes their own role or deactivates themselves, and the last
 *    active ADMIN cannot be demoted or deactivated;
 *  - deactivating, changing a role or resetting a password ends every session.
 * Temporary passwords are returned once and never written to the audit trail.
 */

const ROLES = ['ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const PRIVILEGED: Role[] = ['ADMIN', 'HR_ADMIN'];

export const userQuerySchema = paginationSchema.extend({
  q: optionalTrimmedString(120),
  role: z.enum(ROLES).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED', 'MUST_CHANGE_PASSWORD']).optional(),
});

export const createUserSchema = z.object({
  employeeId: requiredTrimmedString(1, 40),
  /** Defaults to the employee's work email. */
  email: emailSchema.optional(),
  role: z.enum(ROLES),
  scopedLegalEntityId: z.string().trim().min(1).max(40).nullable().optional(),
  temporaryPassword: passwordSchema.optional(),
});

export const updateUserSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    scopedLegalEntityId: z.string().trim().min(1).max(40).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'Nothing to update' });

export const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema.optional() });

export type UserQuery = z.infer<typeof userQuerySchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

const userInclude = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      legalEntityId: true,
      managerId: true,
      status: true,
      department: { select: { id: true, name: true } },
    },
  },
  scopedLegalEntity: { select: { id: true, code: true, name: true } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Whether the caller may change this login (role, status, password). */
function canManageUser(auth: AuthContext, user: UserRow): boolean {
  if (user.id === auth.userId) return false;
  if (PRIVILEGED.includes(user.role)) return isAdmin(auth);
  if (!user.employee) return isAdmin(auth);
  return managesEmployee(auth, user.employee);
}

function assertCanManageUser(auth: AuthContext, user: UserRow): void {
  assertIsManagement(auth);
  if (user.id === auth.userId) {
    throw new ForbiddenError('Use your profile to change your own password; your role and status are changed by another administrator');
  }
  if (!canManageUser(auth, user)) {
    throw new ForbiddenError(
      PRIVILEGED.includes(user.role)
        ? 'Only an administrator can change an ADMIN or HR_ADMIN account'
        : 'This account belongs to an employee outside your scope',
    );
  }
}

function serializeUser(user: UserRow, auth: AuthContext, now = new Date()) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    isLocked: Boolean(user.lockedUntil && user.lockedUntil > now),
    lockedUntil: user.lockedUntil && user.lockedUntil > now ? user.lockedUntil : null,
    failedLoginAttempts: user.failedLoginAttempts,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    scopedLegalEntity: user.scopedLegalEntity,
    employee: user.employee
      ? {
          id: user.employee.id,
          employeeNumber: user.employee.employeeNumber,
          fullName: `${user.employee.firstName} ${user.employee.lastName}`,
          jobTitle: user.employee.jobTitle,
          status: user.employee.status,
          department: user.employee.department,
        }
      : null,
    isSelf: user.id === auth.userId,
    canManage: canManageUser(auth, user),
  };
}

async function loadUser(userId: string): Promise<UserRow> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: userInclude });
  if (!user) throw new NotFoundError('User');
  return user;
}

/** A scoped HR admin sees the logins of their own entity's employees only. */
function scopeWhere(auth: AuthContext): Prisma.UserWhereInput {
  const scope = scopedEntityId(auth);
  return scope ? { employee: { legalEntityId: scope } } : {};
}

export async function listUsers(
  auth: AuthContext,
  query: UserQuery,
): Promise<{ items: unknown[]; meta: PageMeta; summary: Record<string, number> }> {
  assertIsManagement(auth);
  const now = new Date();
  const filters: Prisma.UserWhereInput[] = [scopeWhere(auth)];
  if (query.role) filters.push({ role: query.role });
  if (query.status === 'ACTIVE') filters.push({ isActive: true });
  if (query.status === 'INACTIVE') filters.push({ isActive: false });
  if (query.status === 'LOCKED') filters.push({ lockedUntil: { gt: now } });
  if (query.status === 'MUST_CHANGE_PASSWORD') filters.push({ mustChangePassword: true });
  if (query.q) {
    filters.push({
      OR: [
        { email: { contains: query.q, mode: 'insensitive' } },
        { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
        { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }
  const where: Prisma.UserWhereInput = { AND: filters };
  const { skip, take } = toSkipTake(query);

  const [users, total, byRole] = await Promise.all([
    prisma.user.findMany({ where, include: userInclude, orderBy: [{ role: 'asc' }, { email: 'asc' }], skip, take }),
    prisma.user.count({ where }),
    prisma.user.groupBy({ by: ['role'], where: scopeWhere(auth), _count: { _all: true } }),
  ]);

  const summary: Record<string, number> = { ADMIN: 0, HR_ADMIN: 0, MANAGER: 0, EMPLOYEE: 0 };
  for (const row of byRole) summary[row.role] = row._count._all;

  return { items: users.map((user) => serializeUser(user, auth, now)), meta: buildPageMeta(query.page, query.pageSize, total), summary };
}

/** Employees in scope who have no login yet - the choices for "Create login". */
export async function listEmployeesWithoutLogin(auth: AuthContext): Promise<unknown[]> {
  assertIsManagement(auth);
  const scope = scopedEntityId(auth);
  const employees = await prisma.employee.findMany({
    where: { user: null, status: { not: 'OFFBOARDED' }, ...(scope ? { legalEntityId: scope } : {}) },
    select: { id: true, employeeNumber: true, firstName: true, lastName: true, workEmail: true, jobTitle: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  return employees.map((employee) => ({
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    fullName: `${employee.firstName} ${employee.lastName}`,
    workEmail: employee.workEmail,
    jobTitle: employee.jobTitle,
  }));
}

export async function createUser(
  auth: AuthContext,
  input: CreateUserInput,
  fingerprint: Fingerprint,
): Promise<{ user: unknown; temporaryPassword: string }> {
  assertCanAssignRole(auth, input.role, input.scopedLegalEntityId ?? null);
  if (input.scopedLegalEntityId) assertEntityInScope(auth, input.scopedLegalEntityId);

  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true, workEmail: true, status: true, user: { select: { id: true } } },
  });
  if (!employee) throw new NotFoundError('Employee');
  if (!managesEmployee(auth, employee)) throw new ForbiddenError('This employee is outside your scope');
  if (employee.user) throw new ConflictError('This employee already has a login');
  if (employee.status === 'OFFBOARDED') {
    throw new ValidationError('Validation failed', { employeeId: ['An offboarded employee cannot be given a login'] });
  }

  const email = (input.email ?? employee.workEmail).toLowerCase();
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new ConflictError('Another login already uses this email address');
  }

  const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash: await hashPassword(temporaryPassword),
        role: input.role,
        employeeId: employee.id,
        scopedLegalEntityId: input.role === 'HR_ADMIN' ? (input.scopedLegalEntityId ?? null) : null,
        mustChangePassword: true,
      },
      include: userInclude,
    });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        legalEntityId: employee.legalEntityId,
        summary: `Created ${input.role} login ${email} for employee ${employee.employeeNumber}`,
        after: { email, role: input.role, scopedLegalEntityId: user.scopedLegalEntityId },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return user;
  });

  return { user: serializeUser(created, auth), temporaryPassword };
}

async function assertNotLastAdmin(user: UserRow, change: { role?: Role; isActive?: boolean }): Promise<void> {
  if (user.role !== 'ADMIN' || !user.isActive) return;
  const demoted = change.role !== undefined && change.role !== 'ADMIN';
  const deactivated = change.isActive === false;
  if (!demoted && !deactivated) return;
  const otherAdmins = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, id: { not: user.id } } });
  if (otherAdmins === 0) {
    throw new ConflictError('This is the last active administrator. Make someone else an administrator first.');
  }
}

export async function updateUser(
  auth: AuthContext,
  userId: string,
  input: UpdateUserInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const user = await loadUser(userId);
  assertCanManageUser(auth, user);

  const role = input.role ?? user.role;
  const scope = input.scopedLegalEntityId !== undefined ? input.scopedLegalEntityId : user.scopedLegalEntityId;
  if (input.role !== undefined || input.scopedLegalEntityId !== undefined) {
    // An entity scope only means something on an HR_ADMIN; moving away from
    // HR_ADMIN drops it.
    assertCanAssignRole(auth, role, role === 'HR_ADMIN' ? scope : null);
    if (role === 'HR_ADMIN' && scope) assertEntityInScope(auth, scope);
  }
  await assertNotLastAdmin(user, input);

  const nextScope = role === 'HR_ADMIN' ? (scope ?? null) : null;
  const endsSessions =
    (input.isActive === false && user.isActive) || role !== user.role || nextScope !== user.scopedLegalEntityId;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.user.update({
      where: { id: userId },
      data: {
        role,
        scopedLegalEntityId: nextScope,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      include: userInclude,
    });
    if (endsSessions) {
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        legalEntityId: user.employee?.legalEntityId ?? null,
        summary: `Updated login ${user.email}${role !== user.role ? `: role ${user.role} -> ${role}` : ''}${
          input.isActive === false && user.isActive ? ': deactivated' : input.isActive === true && !user.isActive ? ': reactivated' : ''
        }`,
        before: { role: user.role, scopedLegalEntityId: user.scopedLegalEntityId, isActive: user.isActive },
        after: { role: saved.role, scopedLegalEntityId: saved.scopedLegalEntityId, isActive: saved.isActive, sessionsEnded: endsSessions },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });

  return serializeUser(updated, auth);
}

export async function resetUserPassword(
  auth: AuthContext,
  userId: string,
  input: z.infer<typeof resetPasswordSchema>,
  fingerprint: Fingerprint,
): Promise<{ user: unknown; temporaryPassword: string }> {
  const user = await loadUser(userId);
  assertCanManageUser(auth, user);

  const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      include: userInclude,
    });
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordAudit(
      {
        action: 'PASSWORD_CHANGE',
        entityType: 'User',
        entityId: userId,
        legalEntityId: user.employee?.legalEntityId ?? null,
        summary: `Reset the password of ${user.email}; all sessions ended`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });

  return { user: serializeUser(updated, auth), temporaryPassword };
}

export async function unlockUser(auth: AuthContext, userId: string, fingerprint: Fingerprint): Promise<unknown> {
  const user = await loadUser(userId);
  assertCanManageUser(auth, user);

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
      include: userInclude,
    });
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        legalEntityId: user.employee?.legalEntityId ?? null,
        summary: `Unlocked login ${user.email}`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });
  return serializeUser(updated, auth);
}
