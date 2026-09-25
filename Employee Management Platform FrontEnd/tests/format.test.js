import { describe, expect, it } from 'vitest'
import { formatAmount, formatDate, formatDays, formatMinutes, formatMonth, monthBounds, plural, shiftMonthKey } from '../src/lib/format.js'

describe('money formatting', () => {
  it('shows server-rounded amounts with two decimals and the record currency', () => {
    expect(formatAmount(5883.33, 'AED')).toBe('AED 5,883.33')
    expect(formatAmount('6550', 'AED')).toBe('AED 6,550.00')
    expect(formatAmount(0, 'AED')).toBe('AED 0.00')
  })

  it('puts the sign after the currency for negative amounts', () => {
    expect(formatAmount(-500, 'AED')).toBe('AED -500.00')
  })

  it('never invents a value for missing amounts', () => {
    expect(formatAmount(null, 'AED')).toBe('—')
    expect(formatAmount(undefined)).toBe('—')
    expect(formatAmount('not a number', 'AED')).toBe('—')
  })

  it('formats without a currency when the record has none', () => {
    expect(formatAmount(1234.5)).toBe('1,234.50')
  })
})

describe('dates', () => {
  it('treats an API date as a calendar day, never shifting it across timezones', () => {
    expect(formatDate('2026-08-30')).toBe('30 Aug 2026')
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026')
  })

  it('names payroll months', () => {
    expect(formatMonth('2026-09')).toBe('September 2026')
    expect(formatMonth('')).toBe('—')
  })

  it('computes month bounds, including leap years', () => {
    expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('shifts months across year boundaries', () => {
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01')
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12')
    expect(shiftMonthKey('2026-09', 6)).toBe('2027-03')
  })
})

describe('durations and counts', () => {
  it('reads minutes as hours and minutes', () => {
    expect(formatMinutes(0)).toBe('0m')
    expect(formatMinutes(30)).toBe('30m')
    expect(formatMinutes(95)).toBe('1h 35m')
    expect(formatMinutes(480)).toBe('8h')
    expect(formatMinutes(-15)).toBe('-15m')
  })

  it('counts days, including half days', () => {
    expect(formatDays(1)).toBe('1 day')
    expect(formatDays(2)).toBe('2 days')
    expect(formatDays(0.5)).toBe('0.5 days')
    expect(plural(1, 'entity', 'entities')).toBe('1 entity')
    expect(plural(3, 'payslip')).toBe('3 payslips')
  })
})
