import { Prisma } from '@prisma/client';

/**
 * Money arithmetic. Every monetary value is a `Prisma.Decimal` (decimal.js) -
 * never a JavaScript number - from the moment it leaves the database until it
 * is written back. Numbers only appear at the very edge, when a figure is
 * serialised for display.
 *
 * Rounding is half-up to two decimal places, applied once per payslip line.
 * Totals are sums of already-rounded lines, so a payslip always adds up to the
 * cent and nobody can find a 0.01 discrepancy between the lines and the total.
 */

export type Money = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export const ZERO: Money = new Prisma.Decimal(0);

export function money(value: Prisma.Decimal.Value): Money {
  return new Prisma.Decimal(value);
}

/** Half-up to cents: 166.665 -> 166.67. */
export function round2(value: Money): Money {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Rates keep four places so a rounded rate never skews a large quantity. */
export function round4(value: Money): Money {
  return value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

export function sum(values: Money[]): Money {
  return values.reduce((total, value) => total.plus(value), ZERO);
}

/**
 * Splits an amount into `parts` instalments that add up exactly: every
 * instalment is the amount divided evenly and rounded down to the cent, and the
 * last one absorbs the remainder. 1,000 in 3 -> 333.33, 333.33, 333.34.
 */
export function splitEvenly(total: Money, parts: number): Money[] {
  if (parts < 1) throw new Error('Cannot split into fewer than one part');
  const base = total.dividedBy(parts).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const result = Array.from({ length: parts }, () => base);
  const remainder = total.minus(base.times(parts));
  result[parts - 1] = base.plus(remainder);
  return result;
}

/** For JSON output only - never feed the result back into arithmetic. */
export function toAmount(value: Money | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(round2(value).toFixed(2));
}
