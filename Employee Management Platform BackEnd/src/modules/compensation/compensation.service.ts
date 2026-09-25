import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { toAmount } from '../../services/money';
import { prisma } from '../../db/prisma';
import { dateStringSchema, optionalTrimmedString, requiredTrimmedString, toUtcDate } from '../../common/validate';
import { NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { assertCanEditCompensation, assertCanViewCompensation } from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { addDays } from '../../services/working-days';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

export const createCompensationSchema = z.object({
  baseSalary: z.coerce.number().nonnegative().max(100_000_000),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  payFrequency: z.enum(['MONTHLY', 'BIWEEKLY', 'ANNUAL']).default('MONTHLY'),
  housingAllowance: z.coerce.number().nonnegative().max(100_000_000).default(0),
  transportAllowance: z.coerce.number().nonnegative().max(100_000_000).default(0),
  otherAllowances: z.coerce.number().nonnegative().max(100_000_000).default(0),
  variablePayPercent: z.coerce.number().min(0).max(100).default(0),
  effectiveFrom: dateStringSchema,
  changeReason: requiredTrimmedString(3, 200),
  note: optionalTrimmedString(500),
});

export type CreateCompensationInput = z.infer<typeof createCompensationSchema>;

function serializeRecord(record: {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  baseSalary: Prisma.Decimal;
  currency: string;
  payFrequency: string;
  housingAllowance: Prisma.Decimal;
  transportAllowance: Prisma.Decimal;
  otherAllowances: Prisma.Decimal;
  variablePayPercent: Prisma.Decimal;
  changeReason: string;
  note: string | null;
  isCurrent: boolean;
  createdAt: Date;
}) {
  // Decimal arithmetic; numbers only at the JSON edge.
  const totalFixed = record.baseSalary
    .plus(record.housingAllowance)
    .plus(record.transportAllowance)
    .plus(record.otherAllowances);

  return {
    id: record.id,
    effectiveFrom: record.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: record.effectiveTo ? record.effectiveTo.toISOString().slice(0, 10) : null,
    baseSalary: Number(record.baseSalary),
    currency: record.currency,
    payFrequency: record.payFrequency,
    housingAllowance: Number(record.housingAllowance),
    transportAllowance: Number(record.transportAllowance),
    otherAllowances: Number(record.otherAllowances),
    variablePayPercent: Number(record.variablePayPercent),
    // Precomputed so every client shows the same figure rather than each one
    // reimplementing the arithmetic.
    totalFixed: toAmount(totalFixed),
    changeReason: record.changeReason,
    note: record.note,
    isCurrent: record.isCurrent,
    createdAt: record.createdAt,
  };
}

async function loadSubject(employeeId: string) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, legalEntityId: true, managerId: true, employeeNumber: true, legalEntity: { select: { currency: true } } },
  });
  if (!employee) {
    throw new NotFoundError('Employee');
  }
  return employee;
}

/**
 * Reading compensation is itself audited.
 *
 * Who looked at a salary matters as much as who changed it, and the trail is
 * what makes the "restricted data" claim verifiable rather than aspirational.
 */
export async function getCompensationHistory(
  auth: AuthContext,
  employeeId: string,
  fingerprint: Fingerprint,
): Promise<{ current: unknown; history: unknown[] }> {
  const employee = await loadSubject(employeeId);
  assertCanViewCompensation(auth, employee);

  const records = await prisma.compensationRecord.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: 'desc' },
  });

  // Viewing one's own salary is not noteworthy; another person reading it is.
  if (auth.employeeId !== employeeId) {
    await recordAudit({
      action: 'VIEW_SENSITIVE',
      entityType: 'CompensationRecord',
      entityId: employeeId,
      legalEntityId: employee.legalEntityId,
      summary: `Viewed compensation for employee ${employee.employeeNumber}`,
      actor: auth,
      ...fingerprint,
    });
  }

  const serialized = records.map(serializeRecord);
  return {
    current: serialized.find((record) => record.isCurrent) ?? null,
    history: serialized,
  };
}

/**
 * Records a compensation change as a new dated row rather than an edit.
 *
 * The previous record is closed the day before the new one starts, so the table
 * always answers "what were they paid on this date" and the history cannot be
 * rewritten.
 */
export async function createCompensationRecord(
  auth: AuthContext,
  employeeId: string,
  input: CreateCompensationInput,
  fingerprint: Fingerprint,
): Promise<unknown> {
  const employee = await loadSubject(employeeId);
  assertCanEditCompensation(auth, employee);

  const effectiveFrom = toUtcDate(input.effectiveFrom);

  const previous = await prisma.compensationRecord.findFirst({
    where: { employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (previous && effectiveFrom.getTime() <= previous.effectiveFrom.getTime()) {
    throw new ValidationError('Validation failed', {
      effectiveFrom: ['The effective date must be after the current compensation record starts'],
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.compensationRecord.update({
        where: { id: previous.id },
        data: { isCurrent: false, effectiveTo: addDays(effectiveFrom, -1) },
      });
    }

    const record = await tx.compensationRecord.create({
      data: {
        employeeId,
        effectiveFrom,
        baseSalary: new Prisma.Decimal(input.baseSalary),
        currency: input.currency ?? previous?.currency ?? employee.legalEntity.currency,
        payFrequency: input.payFrequency,
        housingAllowance: new Prisma.Decimal(input.housingAllowance),
        transportAllowance: new Prisma.Decimal(input.transportAllowance),
        otherAllowances: new Prisma.Decimal(input.otherAllowances),
        variablePayPercent: new Prisma.Decimal(input.variablePayPercent),
        changeReason: input.changeReason,
        note: input.note ?? null,
        isCurrent: true,
        createdById: auth.userId,
      },
    });

    await tx.employmentEvent.create({
      data: {
        employeeId,
        type: 'COMPENSATION_CHANGE',
        effectiveDate: effectiveFrom,
        title: input.changeReason,
        description: input.note ?? null,
        // The timeline is visible to more people than the salary itself, so it
        // records that pay changed and by how much in percentage terms - never
        // the amount.
        previousValue: previous ? { baseSalary: 'restricted' } : Prisma.JsonNull,
        newValue: previous
          ? {
              changePercent: Number(
                (((input.baseSalary - Number(previous.baseSalary)) / Number(previous.baseSalary)) * 100).toFixed(1),
              ),
            }
          : Prisma.JsonNull,
        createdById: auth.userId,
      },
    });

    await recordAudit(
      {
        action: 'UPDATE',
        entityType: 'CompensationRecord',
        entityId: record.id,
        legalEntityId: employee.legalEntityId,
        summary: `Compensation change for employee ${employee.employeeNumber}: ${input.changeReason}`,
        before: previous ? { baseSalary: Number(previous.baseSalary), currency: previous.currency } : null,
        after: { baseSalary: input.baseSalary, currency: record.currency, effectiveFrom: input.effectiveFrom },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );

    return record;
  });

  return serializeRecord(created);
}
