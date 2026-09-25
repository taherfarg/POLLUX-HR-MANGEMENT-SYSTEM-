import { describe, expect, it } from 'vitest';
import {
  calculatePayroll,
  employedFraction,
  type PayrollInput,
  type PayrollPolicy,
} from '../src/modules/payroll/payroll.engine';
import { money, splitEvenly, sum } from '../src/services/money';

/**
 * The payroll arithmetic, with Decimal inputs and exact expected figures.
 * Every amount here is compared as a string so a floating-point slip (0.1 +
 * 0.2 style) could not pass by accident.
 */

const policy: PayrollPolicy = {
  salaryDayBasis: 'FIXED_30',
  deductionBase: 'BASIC',
  overtimeBase: 'BASIC',
  standardDailyHours: money(8),
  absenceDeductionEnabled: true,
  unpaidLeaveDeductionEnabled: true,
  lateDeductionEnabled: false,
};

function input(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    periodDays: 30,
    employedDays: 30,
    periodWorkingDays: 22,
    employedWorkingDays: 22,
    segments: [
      {
        compensationRecordId: 'comp-1',
        fromKey: '2026-09-01',
        toKey: '2026-09-30',
        baseSalary: money(5000),
        housingAllowance: money(500),
        transportAllowance: money(500),
        otherAllowances: money(0),
      },
    ],
    absentDays: money(0),
    unpaidLeaveDays: money(0),
    lateMinutes: 0,
    overtime: [],
    adjustments: [],
    installments: [],
    ...overrides,
  };
}

const amounts = (result: ReturnType<typeof calculatePayroll>) =>
  Object.fromEntries(result.lines.map((line) => [line.type === 'OVERTIME' ? `${line.type}:${line.sourceId}` : line.type, line.amount.toFixed(2)]));

describe('payroll engine', () => {
  it('reproduces the brief example: 5,000 basic + allowances, overtime, bonus, advance and unpaid leave', () => {
    const result = calculatePayroll(
      input({
        // Two approved overtime entries of 4.8 hours at 1.25 x (5000 / 30 / 8) = 125.00 each.
        overtime: [
          { id: 'ot-1', dateKey: '2026-09-08', minutes: 288, multiplier: money('1.25') },
          { id: 'ot-2', dateKey: '2026-09-15', minutes: 288, multiplier: money('1.25') },
        ],
        adjustments: [{ id: 'adj-1', type: 'BONUS', kind: 'EARNING', description: 'Sales bonus', amount: money(300) }],
        installments: [{ id: 'inst-1', label: 'Salary advance ADV-2026-0001 (1/6)', amount: money(500) }],
        unpaidLeaveDays: money(1),
      }),
      policy,
    );

    expect(result.grossEarnings.toFixed(2)).toBe('6550.00');
    // One unpaid day at 5000 / 30 = 166.666..., rounded half-up once.
    expect(result.lines.find((line) => line.type === 'UNPAID_LEAVE')?.amount.toFixed(2)).toBe('166.67');
    expect(result.totalDeductions.toFixed(2)).toBe('666.67');
    expect(result.netSalary.toFixed(2)).toBe('5883.33');

    expect(amounts(result)).toMatchObject({
      BASIC_SALARY: '5000.00',
      HOUSING_ALLOWANCE: '500.00',
      TRANSPORT_ALLOWANCE: '500.00',
      'OVERTIME:ot-1': '125.00',
      'OVERTIME:ot-2': '125.00',
      BONUS: '300.00',
      ADVANCE_DEDUCTION: '500.00',
    });
    expect(result.overtimeMinutes).toBe(576);
    expect(result.dailyRate.toFixed(4)).toBe('166.6667');
    expect(result.hourlyRate.toFixed(4)).toBe('20.8333');
  });

  it('pays a full month as exactly the monthly salary on every day basis', () => {
    for (const salaryDayBasis of ['FIXED_30', 'CALENDAR_DAYS', 'WORKING_DAYS'] as const) {
      const february = calculatePayroll(input({ periodDays: 28, employedDays: 28 }), { ...policy, salaryDayBasis });
      expect(february.lines.find((line) => line.type === 'BASIC_SALARY')?.amount.toFixed(2)).toBe('5000.00');
      const thirtyOne = calculatePayroll(input({ periodDays: 31, employedDays: 31 }), { ...policy, salaryDayBasis });
      expect(thirtyOne.grossEarnings.toFixed(2)).toBe('6000.00');
    }
  });

  it('prorates a mid-month joiner according to the day basis', () => {
    // Joined on the 16th of a 30-day month: 15 days employed.
    const partial = input({ employedDays: 15, employedWorkingDays: 11 });

    const fixed = calculatePayroll(partial, policy);
    expect(fixed.lines[0]?.label).toBe('Basic salary (15/30 days)');
    expect(fixed.lines[0]?.amount.toFixed(2)).toBe('2500.00');

    const calendar = calculatePayroll(partial, { ...policy, salaryDayBasis: 'CALENDAR_DAYS' });
    expect(calendar.lines[0]?.amount.toFixed(2)).toBe('2500.00');

    const working = calculatePayroll(partial, { ...policy, salaryDayBasis: 'WORKING_DAYS' });
    // 11 of 22 working days.
    expect(working.lines[0]?.amount.toFixed(2)).toBe('2500.00');
    expect(working.lines[0]?.label).toBe('Basic salary (11/22 working days)');
  });

  it('charges each day not employed at 1/30 on the FIXED_30 basis, even in a 31-day month', () => {
    const { fraction, label } = employedFraction(input({ periodDays: 31, employedDays: 30 }), 'FIXED_30');
    expect(label).toBe('29/30 days');
    expect(fraction.times(5000).toDecimalPlaces(2).toFixed(2)).toBe('4833.33');
  });

  it('splits a month with a mid-month raise between the two salaries by days', () => {
    const result = calculatePayroll(
      input({
        segments: [
          { compensationRecordId: 'old', fromKey: '2026-09-01', toKey: '2026-09-15', baseSalary: money(4000), housingAllowance: money(0), transportAllowance: money(0), otherAllowances: money(0) },
          { compensationRecordId: 'new', fromKey: '2026-09-16', toKey: '2026-09-30', baseSalary: money(6000), housingAllowance: money(0), transportAllowance: money(0), otherAllowances: money(0) },
        ],
      }),
      policy,
    );
    expect(result.lines[0]?.amount.toFixed(2)).toBe('5000.00');
    // Rates follow the salary in force at the end of the period.
    expect(result.current.compensationRecordId).toBe('new');
  });

  it('deducts absence at the daily rate and can use the gross salary as the base', () => {
    const basic = calculatePayroll(input({ absentDays: money(2) }), policy);
    expect(basic.lines.find((line) => line.type === 'ABSENCE')?.amount.toFixed(2)).toBe('333.33');

    const gross = calculatePayroll(input({ absentDays: money(2) }), { ...policy, deductionBase: 'GROSS' });
    // (5000 + 500 + 500) / 30 x 2 = 400.
    expect(gross.lines.find((line) => line.type === 'ABSENCE')?.amount.toFixed(2)).toBe('400.00');
  });

  it('respects the switches for absence, unpaid leave and late deductions', () => {
    const off = calculatePayroll(input({ absentDays: money(1), unpaidLeaveDays: money(1), lateMinutes: 90 }), {
      ...policy,
      absenceDeductionEnabled: false,
      unpaidLeaveDeductionEnabled: false,
      lateDeductionEnabled: false,
    });
    expect(off.totalDeductions.toFixed(2)).toBe('0.00');

    const late = calculatePayroll(input({ lateMinutes: 90 }), { ...policy, lateDeductionEnabled: true });
    // 90 minutes at 5000 / 30 / 8 / 60 per minute = 31.25.
    expect(late.lines.find((line) => line.type === 'LATE_DEDUCTION')?.amount.toFixed(2)).toBe('31.25');
  });

  it('rounds each line once, so the total is exactly the sum of the lines shown', () => {
    // Three overtime lines of 3.2 hours: 83.3333... each, shown as 83.33.
    const result = calculatePayroll(
      input({
        overtime: [1, 2, 3].map((n) => ({ id: `ot-${n}`, dateKey: `2026-09-0${n}`, minutes: 192, multiplier: money('1.25') })),
      }),
      policy,
    );
    const overtimeLines = result.lines.filter((line) => line.type === 'OVERTIME');
    expect(overtimeLines.map((line) => line.amount.toFixed(2))).toEqual(['83.33', '83.33', '83.33']);
    expect(result.grossEarnings.toFixed(2)).toBe(sum(result.lines.map((line) => line.amount)).toFixed(2));
    expect(result.grossEarnings.toFixed(2)).toBe('6249.99');
  });

  it('warns when deductions exceed earnings', () => {
    const result = calculatePayroll(
      input({ installments: [{ id: 'i', label: 'Advance', amount: money(7000) }] }),
      policy,
    );
    expect(result.netSalary.toFixed(2)).toBe('-1000.00');
    expect(result.warnings).toContain('Net salary is negative - deductions exceed earnings');
  });

  it('applies deduction adjustments on the deduction side', () => {
    const result = calculatePayroll(
      input({ adjustments: [{ id: 'd', type: 'DEDUCTION', kind: 'DEDUCTION', description: 'Traffic fine', amount: money('150.5') }] }),
      policy,
    );
    expect(result.lines.find((line) => line.sourceId === 'd')?.type).toBe('OTHER_DEDUCTION');
    expect(result.netSalary.toFixed(2)).toBe('5849.50');
  });
});

describe('instalment splitting', () => {
  it('splits exactly, putting the remainder on the last instalment', () => {
    expect(splitEvenly(money(3000), 6).map((part) => part.toFixed(2))).toEqual(['500.00', '500.00', '500.00', '500.00', '500.00', '500.00']);
    expect(splitEvenly(money(1000), 3).map((part) => part.toFixed(2))).toEqual(['333.33', '333.33', '333.34']);
    expect(sum(splitEvenly(money('2500.01'), 7)).toFixed(2)).toBe('2500.01');
  });
});
