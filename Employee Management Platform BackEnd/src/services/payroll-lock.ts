import type { PayrollStatus } from '@prisma/client';
import type { TxClient } from '../db/prisma';
import { ConflictError } from '../common/errors';

/**
 * The financial lock.
 *
 * Once a payroll period is APPROVED or PAID its figures are final. Anything
 * that fed those figures - attendance in the period, overtime, instalments,
 * adjustments - must not change underneath it, because a payslip that no
 * longer matches its inputs is worse than no payslip. The only way to change
 * a locked month is the explicit, audited reopen action (APPROVED only).
 */

export const LOCKED_PAYROLL_STATUSES: PayrollStatus[] = ['APPROVED', 'PAID'];

export function isLockedPayrollStatus(status: PayrollStatus | null | undefined): boolean {
  return status ? LOCKED_PAYROLL_STATUSES.includes(status) : false;
}

/** True when a source row was consumed by a payroll line in a locked period. */
export function isLockedPayrollItem(
  item: { record: { period: { status: PayrollStatus } } } | null | undefined,
): boolean {
  return isLockedPayrollStatus(item?.record.period.status);
}

/**
 * Refuses a change dated inside a locked payroll month for the entity.
 * `dateKey` is a YYYY-MM-DD calendar date.
 */
export async function assertPayrollPeriodOpen(client: TxClient, legalEntityId: string, dateKey: string): Promise<void> {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const locked = await client.payrollPeriod.findFirst({
    where: {
      legalEntityId,
      status: { in: LOCKED_PAYROLL_STATUSES },
      startDate: { lte: date },
      endDate: { gte: date },
    },
    select: { name: true, status: true },
  });
  if (locked) {
    throw new ConflictError(
      `Payroll for ${locked.name} is ${locked.status.toLowerCase()}, so this date is locked. An administrator must reopen that payroll first.`,
    );
  }
}
