import type { PayBase, PayrollAdjustmentType, PayrollItemKind, PayrollItemType, SalaryDayBasis } from '@prisma/client';
import { money, round2, round4, sum, ZERO, type Money } from '../../services/money';

/**
 * The payroll calculation, as a pure function.
 *
 * Input: one employee's salary configuration for the period, the attendance
 * and leave figures, and the approved overtime, adjustments and advance
 * instalments waiting to be paid. Output: the payslip lines and totals. No
 * database, no clock - the same input always gives the same payslip, which is
 * what lets approval re-run the calculation and prove nothing changed.
 *
 *   Basic salary
 * + Housing, transport and other allowances
 * + Overtime (approved)            hours x hourly rate x multiplier
 * + Bonuses, commissions, other earnings (approved adjustments)
 * - Salary advance instalments
 * - Unpaid leave                   days x daily rate          (policy)
 * - Absence                        days x daily rate          (policy)
 * - Late arrival                   minutes x minute rate      (policy)
 * - Other deductions (approved adjustments)
 * = Net salary
 *
 * Rates are derived from the monthly salary with the company's day basis:
 * FIXED_30 divides by 30, CALENDAR_DAYS by the days in the month, WORKING_DAYS
 * by the employee's scheduled working days in the month. Every line is rounded
 * half-up to the cent once; totals are sums of rounded lines.
 */

export interface PayrollPolicy {
  salaryDayBasis: SalaryDayBasis;
  deductionBase: PayBase;
  overtimeBase: PayBase;
  standardDailyHours: Money;
  absenceDeductionEnabled: boolean;
  unpaidLeaveDeductionEnabled: boolean;
  lateDeductionEnabled: boolean;
}

/** A salary configuration in force for part of the period. Amounts are monthly. */
export interface CompensationSegment {
  compensationRecordId: string;
  fromKey: string;
  toKey: string;
  baseSalary: Money;
  housingAllowance: Money;
  transportAllowance: Money;
  otherAllowances: Money;
}

export interface OvertimeInput {
  id: string;
  dateKey: string;
  minutes: number;
  multiplier: Money;
}

export interface AdjustmentInput {
  id: string;
  type: PayrollAdjustmentType;
  kind: PayrollItemKind;
  description: string;
  amount: Money;
}

export interface InstallmentInput {
  id: string;
  label: string;
  amount: Money;
}

export interface PayrollInput {
  periodDays: number;
  /** Calendar days in the period the employee was employed. */
  employedDays: number;
  /** Scheduled working days in the period (schedule minus holidays). */
  periodWorkingDays: number;
  employedWorkingDays: number;
  /** Oldest first; the last one is the configuration at the end of the period. */
  segments: CompensationSegment[];
  absentDays: Money;
  unpaidLeaveDays: Money;
  lateMinutes: number;
  overtime: OvertimeInput[];
  adjustments: AdjustmentInput[];
  installments: InstallmentInput[];
}

export interface PayrollLine {
  kind: PayrollItemKind;
  type: PayrollItemType;
  label: string;
  quantity: Money | null;
  rate: Money | null;
  amount: Money;
  sourceType: 'OvertimeEntry' | 'PayrollAdjustment' | 'SalaryAdvanceInstallment' | null;
  sourceId: string | null;
  sortOrder: number;
}

export interface PayrollComputation {
  current: CompensationSegment;
  employedFraction: Money;
  prorationLabel: string | null;
  dailyRate: Money;
  hourlyRate: Money;
  lines: PayrollLine[];
  grossEarnings: Money;
  totalDeductions: Money;
  netSalary: Money;
  overtimeMinutes: number;
  warnings: string[];
}

const ONE = money(1);

function daysBetweenKeys(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Share of the monthly salary earned for the employment days in the period.
 *
 * A full month is always exactly 1, whatever the basis - nobody employed all
 * month is paid 28/30 in February. For a partial month, FIXED_30 deducts each
 * day not employed at 1/30 (the same rate an unpaid day costs), CALENDAR_DAYS
 * pays days employed over days in the month, and WORKING_DAYS pays working
 * days employed over working days in the month.
 */
export function employedFraction(input: PayrollInput, basis: SalaryDayBasis): { fraction: Money; label: string | null } {
  if (input.employedDays >= input.periodDays) return { fraction: ONE, label: null };
  if (input.employedDays <= 0) return { fraction: ZERO, label: '0 days' };

  switch (basis) {
    case 'CALENDAR_DAYS':
      return {
        fraction: money(input.employedDays).dividedBy(input.periodDays),
        label: `${input.employedDays}/${input.periodDays} days`,
      };
    case 'WORKING_DAYS':
      if (input.periodWorkingDays <= 0) {
        return { fraction: money(input.employedDays).dividedBy(input.periodDays), label: `${input.employedDays}/${input.periodDays} days` };
      }
      return {
        fraction: money(input.employedWorkingDays).dividedBy(input.periodWorkingDays),
        label: `${input.employedWorkingDays}/${input.periodWorkingDays} working days`,
      };
    default: {
      const paidDays = Math.max(0, 30 - (input.periodDays - input.employedDays));
      return { fraction: money(paidDays).dividedBy(30), label: `${paidDays}/30 days` };
    }
  }
}

function dayDivisor(input: PayrollInput, basis: SalaryDayBasis): number {
  if (basis === 'CALENDAR_DAYS') return input.periodDays;
  if (basis === 'WORKING_DAYS') return Math.max(1, input.periodWorkingDays);
  return 30;
}

function monthlyBase(segment: CompensationSegment, base: PayBase): Money {
  if (base === 'BASIC') return segment.baseSalary;
  return segment.baseSalary.plus(segment.housingAllowance).plus(segment.transportAllowance).plus(segment.otherAllowances);
}

/** A fixed component (basic, an allowance) prorated across salary segments. */
function proratedComponent(
  input: PayrollInput,
  fraction: Money,
  pick: (segment: CompensationSegment) => Money,
): Money {
  if (input.segments.length === 1) {
    return round2(pick(input.segments[0] as CompensationSegment).times(fraction));
  }
  const totalDays = input.segments.reduce((total, segment) => total + daysBetweenKeys(segment.fromKey, segment.toKey), 0);
  if (totalDays === 0) return ZERO;
  // The employed share is split between the salaries in force by how many
  // days each one covered.
  const weighted = sum(
    input.segments.map((segment) =>
      pick(segment).times(fraction).times(daysBetweenKeys(segment.fromKey, segment.toKey)).dividedBy(totalDays),
    ),
  );
  return round2(weighted);
}

const EARNING_TYPES: Record<PayrollAdjustmentType, PayrollItemType> = {
  BONUS: 'BONUS',
  COMMISSION: 'COMMISSION',
  ALLOWANCE: 'ALLOWANCE',
  OVERTIME: 'OVERTIME',
  OTHER: 'OTHER_EARNING',
  DEDUCTION: 'OTHER_EARNING',
  ABSENCE: 'OTHER_EARNING',
  UNPAID_LEAVE: 'OTHER_EARNING',
  ADVANCE: 'OTHER_EARNING',
};

const DEDUCTION_TYPES: Record<PayrollAdjustmentType, PayrollItemType> = {
  DEDUCTION: 'OTHER_DEDUCTION',
  ABSENCE: 'ABSENCE',
  UNPAID_LEAVE: 'UNPAID_LEAVE',
  ADVANCE: 'ADVANCE_DEDUCTION',
  OTHER: 'OTHER_DEDUCTION',
  BONUS: 'OTHER_DEDUCTION',
  COMMISSION: 'OTHER_DEDUCTION',
  ALLOWANCE: 'OTHER_DEDUCTION',
  OVERTIME: 'OTHER_DEDUCTION',
};

function formatDay(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]}`;
}

function formatQuantity(value: Money): string {
  return value.toDecimalPlaces(2).toString();
}

export function calculatePayroll(input: PayrollInput, policy: PayrollPolicy): PayrollComputation {
  if (input.segments.length === 0) {
    throw new Error('calculatePayroll needs at least one compensation segment');
  }
  const current = input.segments[input.segments.length - 1] as CompensationSegment;
  const { fraction, label: prorationLabel } = employedFraction(input, policy.salaryDayBasis);
  const divisor = dayDivisor(input, policy.salaryDayBasis);
  const hoursPerDay = policy.standardDailyHours.greaterThan(0) ? policy.standardDailyHours : money(8);

  // Exact (unrounded) rates for arithmetic; rounded copies for display.
  const dailyExact = monthlyBase(current, policy.deductionBase).dividedBy(divisor);
  const hourlyExact = monthlyBase(current, policy.overtimeBase).dividedBy(divisor).dividedBy(hoursPerDay);
  const minuteDeductionExact = dailyExact.dividedBy(hoursPerDay).dividedBy(60);

  const lines: PayrollLine[] = [];
  let order = 0;
  const add = (line: Omit<PayrollLine, 'sortOrder'>): void => {
    if (line.amount.lessThanOrEqualTo(0)) return;
    lines.push({ ...line, sortOrder: order++ });
  };

  // --- Earnings --------------------------------------------------------------
  add({
    kind: 'EARNING',
    type: 'BASIC_SALARY',
    label: prorationLabel ? `Basic salary (${prorationLabel})` : 'Basic salary',
    quantity: null,
    rate: null,
    amount: proratedComponent(input, fraction, (segment) => segment.baseSalary),
    sourceType: null,
    sourceId: null,
  });
  add({
    kind: 'EARNING',
    type: 'HOUSING_ALLOWANCE',
    label: 'Housing allowance',
    quantity: null,
    rate: null,
    amount: proratedComponent(input, fraction, (segment) => segment.housingAllowance),
    sourceType: null,
    sourceId: null,
  });
  add({
    kind: 'EARNING',
    type: 'TRANSPORT_ALLOWANCE',
    label: 'Transport allowance',
    quantity: null,
    rate: null,
    amount: proratedComponent(input, fraction, (segment) => segment.transportAllowance),
    sourceType: null,
    sourceId: null,
  });
  add({
    kind: 'EARNING',
    type: 'OTHER_ALLOWANCE',
    label: 'Other allowances',
    quantity: null,
    rate: null,
    amount: proratedComponent(input, fraction, (segment) => segment.otherAllowances),
    sourceType: null,
    sourceId: null,
  });

  let overtimeMinutes = 0;
  for (const entry of [...input.overtime].sort((a, b) => a.dateKey.localeCompare(b.dateKey))) {
    const hours = money(entry.minutes).dividedBy(60);
    overtimeMinutes += entry.minutes;
    add({
      kind: 'EARNING',
      type: 'OVERTIME',
      label: `Overtime ${formatDay(entry.dateKey)} (${formatQuantity(hours)} h x ${entry.multiplier.toString()})`,
      quantity: hours.toDecimalPlaces(2),
      rate: round4(hourlyExact.times(entry.multiplier)),
      amount: round2(hours.times(hourlyExact).times(entry.multiplier)),
      sourceType: 'OvertimeEntry',
      sourceId: entry.id,
    });
  }

  for (const adjustment of input.adjustments.filter((candidate) => candidate.kind === 'EARNING')) {
    add({
      kind: 'EARNING',
      type: EARNING_TYPES[adjustment.type],
      label: adjustment.description,
      quantity: null,
      rate: null,
      amount: round2(adjustment.amount),
      sourceType: 'PayrollAdjustment',
      sourceId: adjustment.id,
    });
  }

  // --- Deductions ------------------------------------------------------------
  for (const installment of input.installments) {
    add({
      kind: 'DEDUCTION',
      type: 'ADVANCE_DEDUCTION',
      label: installment.label,
      quantity: null,
      rate: null,
      amount: round2(installment.amount),
      sourceType: 'SalaryAdvanceInstallment',
      sourceId: installment.id,
    });
  }

  if (policy.unpaidLeaveDeductionEnabled && input.unpaidLeaveDays.greaterThan(0)) {
    add({
      kind: 'DEDUCTION',
      type: 'UNPAID_LEAVE',
      label: `Unpaid leave (${formatQuantity(input.unpaidLeaveDays)} day${input.unpaidLeaveDays.equals(1) ? '' : 's'})`,
      quantity: input.unpaidLeaveDays,
      rate: round4(dailyExact),
      amount: round2(input.unpaidLeaveDays.times(dailyExact)),
      sourceType: null,
      sourceId: null,
    });
  }

  if (policy.absenceDeductionEnabled && input.absentDays.greaterThan(0)) {
    add({
      kind: 'DEDUCTION',
      type: 'ABSENCE',
      label: `Absence (${formatQuantity(input.absentDays)} day${input.absentDays.equals(1) ? '' : 's'})`,
      quantity: input.absentDays,
      rate: round4(dailyExact),
      amount: round2(input.absentDays.times(dailyExact)),
      sourceType: null,
      sourceId: null,
    });
  }

  if (policy.lateDeductionEnabled && input.lateMinutes > 0) {
    add({
      kind: 'DEDUCTION',
      type: 'LATE_DEDUCTION',
      label: `Late arrival (${input.lateMinutes} min)`,
      quantity: money(input.lateMinutes),
      rate: round4(minuteDeductionExact),
      amount: round2(minuteDeductionExact.times(input.lateMinutes)),
      sourceType: null,
      sourceId: null,
    });
  }

  for (const adjustment of input.adjustments.filter((candidate) => candidate.kind === 'DEDUCTION')) {
    add({
      kind: 'DEDUCTION',
      type: DEDUCTION_TYPES[adjustment.type],
      label: adjustment.description,
      quantity: null,
      rate: null,
      amount: round2(adjustment.amount),
      sourceType: 'PayrollAdjustment',
      sourceId: adjustment.id,
    });
  }

  const grossEarnings = sum(lines.filter((line) => line.kind === 'EARNING').map((line) => line.amount));
  const totalDeductions = sum(lines.filter((line) => line.kind === 'DEDUCTION').map((line) => line.amount));
  const netSalary = grossEarnings.minus(totalDeductions);

  const warnings: string[] = [];
  if (netSalary.lessThan(0)) warnings.push('Net salary is negative - deductions exceed earnings');

  return {
    current,
    employedFraction: fraction,
    prorationLabel,
    dailyRate: round4(dailyExact),
    hourlyRate: round4(hourlyExact),
    lines,
    grossEarnings,
    totalDeductions,
    netSalary,
    overtimeMinutes,
    warnings,
  };
}
