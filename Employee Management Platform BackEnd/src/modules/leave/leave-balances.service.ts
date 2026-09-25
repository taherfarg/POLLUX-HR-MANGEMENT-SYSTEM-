import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertCanManageEntityConfig, isManagement, managesEmployee, scopedEntityId } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { resolveLegalEntityId } from '../../services/company';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Leave balances across people: the HR view of entitlement, carried-over,
 * used, pending and available days, the audited manual adjustment, and the
 * yearly generation of next year's balances with carry-over.
 *
 * Days are not money, but the same rule applies: the arithmetic is done in
 * Decimal so 0.5 + 0.5 + ... never drifts, and only the response holds numbers.
 */

export const balanceQuerySchema = paginationSchema.extend({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  employeeId: optionalTrimmedString(40),
  departmentId: optionalTrimmedString(40),
  workLocationId: optionalTrimmedString(40),
  leaveTypeId: optionalTrimmedString(40),
  q: optionalTrimmedString(120),
});

export const balanceAdjustSchema = z
  .object({
    entitledDays: z.coerce.number().min(0).max(366).multipleOf(0.5).optional(),
    carriedOverDays: z.coerce.number().min(0).max(366).multipleOf(0.5).optional(),
    reason: requiredTrimmedString(3, 300),
  })
  .refine((value) => value.entitledDays !== undefined || value.carriedOverDays !== undefined, {
    message: 'Change the entitlement or the carried-over days',
    path: ['entitledDays'],
  });

export const balanceGenerateSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  legalEntityId: optionalTrimmedString(40),
  /** Carry unused days from the previous year, up to each leave type's limit. */
  carryOver: z.boolean().default(true),
  /** Someone joining during the year gets the months they will work. */
  prorateNewJoiners: z.boolean().default(true),
});

export type BalanceQuery = z.infer<typeof balanceQuerySchema>;

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

const balanceInclude = {
  leaveType: { select: { id: true, code: true, name: true, colorHex: true, isPaid: true, carryOverMaxDays: true } },
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      legalEntityId: true,
      managerId: true,
      department: { select: { id: true, name: true } },
      workLocation: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.LeaveBalanceInclude;

type BalanceRow = Prisma.LeaveBalanceGetPayload<{ include: typeof balanceInclude }>;

export function balanceFigures(balance: {
  entitledDays: Prisma.Decimal;
  carriedOverDays: Prisma.Decimal;
  usedDays: Prisma.Decimal;
  pendingDays: Prisma.Decimal;
}) {
  const total = balance.entitledDays.plus(balance.carriedOverDays);
  const available = total.minus(balance.usedDays).minus(balance.pendingDays);
  return {
    entitledDays: balance.entitledDays.toNumber(),
    carriedOverDays: balance.carriedOverDays.toNumber(),
    totalEntitlement: total.toNumber(),
    usedDays: balance.usedDays.toNumber(),
    pendingDays: balance.pendingDays.toNumber(),
    availableDays: available.toNumber(),
  };
}

function serializeBalance(balance: BalanceRow) {
  return {
    id: balance.id,
    year: balance.year,
    leaveType: {
      id: balance.leaveType.id,
      code: balance.leaveType.code,
      name: balance.leaveType.name,
      colorHex: balance.leaveType.colorHex,
      isPaid: balance.leaveType.isPaid,
    },
    employee: {
      id: balance.employee.id,
      employeeNumber: balance.employee.employeeNumber,
      fullName: `${balance.employee.firstName} ${balance.employee.lastName}`,
      department: balance.employee.department,
      workLocation: balance.employee.workLocation,
    },
    ...balanceFigures(balance),
    updatedAt: balance.updatedAt,
  };
}

/** HR: their scope. A manager: their direct reports and themselves. Anyone else: their own. */
function subjectWhere(auth: AuthContext): Prisma.EmployeeWhereInput {
  if (isManagement(auth)) {
    const scope = scopedEntityId(auth);
    return scope ? { legalEntityId: scope } : {};
  }
  if (!auth.employeeId) return { id: '__none__' };
  if (auth.role === 'MANAGER') return { OR: [{ id: auth.employeeId }, { managerId: auth.employeeId }] };
  return { id: auth.employeeId };
}

export async function listBalances(
  auth: AuthContext,
  query: BalanceQuery,
): Promise<{ items: unknown[]; meta: PageMeta; totals: Record<string, number> }> {
  const year = query.year ?? new Date().getUTCFullYear();
  const employee: Prisma.EmployeeWhereInput = {
    AND: [
      subjectWhere(auth),
      query.employeeId ? { id: query.employeeId } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.workLocationId ? { workLocationId: query.workLocationId } : {},
      query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              { employeeNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  };
  const where: Prisma.LeaveBalanceWhereInput = {
    year,
    employee,
    ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
  };
  const { skip, take } = toSkipTake(query);

  const [rows, total, sums] = await Promise.all([
    prisma.leaveBalance.findMany({
      where,
      include: balanceInclude,
      orderBy: [{ employee: { firstName: 'asc' } }, { employee: { lastName: 'asc' } }, { leaveType: { name: 'asc' } }],
      skip,
      take,
    }),
    prisma.leaveBalance.count({ where }),
    prisma.leaveBalance.aggregate({
      where,
      _sum: { entitledDays: true, carriedOverDays: true, usedDays: true, pendingDays: true },
    }),
  ]);

  const totals = balanceFigures({
    entitledDays: sums._sum.entitledDays ?? D(0),
    carriedOverDays: sums._sum.carriedOverDays ?? D(0),
    usedDays: sums._sum.usedDays ?? D(0),
    pendingDays: sums._sum.pendingDays ?? D(0),
  });

  return { items: rows.map(serializeBalance), meta: buildPageMeta(query.page, query.pageSize, total), totals };
}

/**
 * A manual correction - a negotiated extra day, a carried-over figure agreed
 * outside the system. Never lets the balance fall below what is already taken
 * or waiting for a decision.
 */
export async function adjustBalance(
  auth: AuthContext,
  balanceId: string,
  input: z.infer<typeof balanceAdjustSchema>,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const balance = await prisma.leaveBalance.findUnique({ where: { id: balanceId }, include: balanceInclude });
  if (!balance) throw new NotFoundError('Leave balance');
  if (!managesEmployee(auth, balance.employee)) {
    throw new ForbiddenError('Only HR can adjust leave balances');
  }

  const entitledDays = input.entitledDays === undefined ? balance.entitledDays : D(input.entitledDays);
  const carriedOverDays = input.carriedOverDays === undefined ? balance.carriedOverDays : D(input.carriedOverDays);
  const committed = balance.usedDays.plus(balance.pendingDays);
  if (entitledDays.plus(carriedOverDays).lessThan(committed)) {
    throw new ValidationError('Validation failed', {
      entitledDays: [`${committed.toString()} day(s) are already taken or pending - the entitlement cannot be lower`],
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.leaveBalance.update({
      where: { id: balanceId },
      data: { entitledDays, carriedOverDays },
      include: balanceInclude,
    });
    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'LeaveBalance',
        entityId: balanceId,
        legalEntityId: balance.employee.legalEntityId,
        summary: `Adjusted ${balance.year} ${balance.leaveType.name} balance of ${balance.employee.employeeNumber}: ${input.reason}`,
        before: { entitledDays: balance.entitledDays.toString(), carriedOverDays: balance.carriedOverDays.toString() },
        after: { entitledDays: entitledDays.toString(), carriedOverDays: carriedOverDays.toString(), reason: input.reason },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return saved;
  });

  return serializeBalance(updated);
}

/**
 * Creates the year's balances for every current employee and leave type that
 * does not have one yet. Existing balances are never overwritten, so running
 * it twice is harmless. Carried-over days are what was left unused the year
 * before, capped by the leave type's carry-over limit.
 */
export async function generateBalances(
  auth: AuthContext,
  input: z.infer<typeof balanceGenerateSchema>,
  fingerprint: Fingerprint,
): Promise<{ year: number; created: number; skipped: number; carriedOver: number }> {
  const legalEntityId = await resolveLegalEntityId(auth, input.legalEntityId);
  assertCanManageEntityConfig(auth, legalEntityId);

  const yearStart = new Date(Date.UTC(input.year, 0, 1));
  const yearEnd = new Date(Date.UTC(input.year, 11, 31));

  const [leaveTypes, employees] = await Promise.all([
    prisma.leaveType.findMany({
      where: { isActive: true, OR: [{ legalEntityId }, { legalEntityId: null }] },
    }),
    prisma.employee.findMany({
      where: {
        legalEntityId,
        status: { not: 'OFFBOARDED' },
        hireDate: { lte: yearEnd },
        OR: [{ exitDate: null }, { exitDate: { gte: yearStart } }],
      },
      select: { id: true, hireDate: true, gender: true },
    }),
  ]);

  const ids = employees.map((employee) => employee.id);
  const [existing, previous] = await Promise.all([
    prisma.leaveBalance.findMany({ where: { employeeId: { in: ids }, year: input.year }, select: { employeeId: true, leaveTypeId: true } }),
    input.carryOver
      ? prisma.leaveBalance.findMany({ where: { employeeId: { in: ids }, year: input.year - 1 } })
      : Promise.resolve([]),
  ]);
  const has = new Set(existing.map((row) => `${row.employeeId}:${row.leaveTypeId}`));
  const previousByKey = new Map(previous.map((row) => [`${row.employeeId}:${row.leaveTypeId}`, row]));

  const data: Prisma.LeaveBalanceCreateManyInput[] = [];
  let skipped = 0;
  let carriedOver = 0;
  for (const employee of employees) {
    const monthsRemaining =
      input.prorateNewJoiners && employee.hireDate.getUTCFullYear() === input.year ? 12 - employee.hireDate.getUTCMonth() : 12;
    for (const type of leaveTypes) {
      if (type.restrictedToGender && type.restrictedToGender !== employee.gender) continue;
      const key = `${employee.id}:${type.id}`;
      if (has.has(key)) {
        skipped += 1;
        continue;
      }
      // Nearest half day, the same rounding as a new joiner's first balance.
      const entitled = type.annualEntitlementDays.times(monthsRemaining).dividedBy(12).times(2).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).dividedBy(2);

      let carried = D(0);
      const last = previousByKey.get(key);
      if (last && type.carryOverMaxDays.greaterThan(0)) {
        const unused = last.entitledDays.plus(last.carriedOverDays).minus(last.usedDays).minus(last.pendingDays);
        carried = Prisma.Decimal.max(D(0), Prisma.Decimal.min(unused, type.carryOverMaxDays));
        if (carried.greaterThan(0)) carriedOver += 1;
      }
      data.push({ employeeId: employee.id, leaveTypeId: type.id, year: input.year, entitledDays: entitled, carriedOverDays: carried });
    }
  }

  await prisma.$transaction(async (tx) => {
    if (data.length > 0) await tx.leaveBalance.createMany({ data, skipDuplicates: true });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'LeaveBalance',
        legalEntityId,
        summary: `Generated ${data.length} leave balance(s) for ${input.year}${input.carryOver ? ` with carry-over (${carriedOver})` : ''}`,
        after: { year: input.year, created: data.length, skipped, carryOver: input.carryOver, prorateNewJoiners: input.prorateNewJoiners },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
  });

  return { year: input.year, created: data.length, skipped, carriedOver };
}
