import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  clockToMinutes,
  dateKeysInRange,
  dayOfWeekForDateKey,
  isValidTimeZone,
  minutesToClock,
  timeZoneOffsetMinutes,
  zonedClock,
  zonedDateKey,
  zonedMinuteOfDay,
  zonedWallTimeToUtc,
} from '../src/services/timezone';

/**
 * The timezone rules attendance depends on: UTC instants in, local calendar
 * meaning out. Cairo is the interesting case - Egypt observes DST (in 2026 it
 * starts on Friday 24 April) - while Dubai and Algiers keep a fixed offset.
 */
describe('timezone arithmetic', () => {
  it('knows the fixed offsets of Dubai and Algiers', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Asia/Dubai')).toBe(240);
    expect(timeZoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Asia/Dubai')).toBe(240);
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Africa/Algiers')).toBe(60);
    expect(timeZoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Africa/Algiers')).toBe(60);
  });

  it('follows Cairo across its daylight-saving change', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-04-23T12:00:00Z'), 'Africa/Cairo')).toBe(120);
    expect(timeZoneOffsetMinutes(new Date('2026-04-24T12:00:00Z'), 'Africa/Cairo')).toBe(180);
  });

  it('turns 09:00 local into the right UTC instant in each zone', () => {
    expect(zonedWallTimeToUtc('2026-09-25', 9 * 60, 'Asia/Dubai').toISOString()).toBe('2026-09-25T05:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-09-25', 9 * 60, 'Africa/Algiers').toISOString()).toBe('2026-09-25T08:00:00.000Z');
    // The day before and the day of the DST change: same wall time, one hour apart in UTC.
    expect(zonedWallTimeToUtc('2026-04-23', 9 * 60, 'Africa/Cairo').toISOString()).toBe('2026-04-23T07:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-04-24', 9 * 60, 'Africa/Cairo').toISOString()).toBe('2026-04-24T06:00:00.000Z');
  });

  it('round-trips a wall time through UTC', () => {
    for (const zone of ['Asia/Dubai', 'Africa/Cairo', 'Africa/Algiers']) {
      const instant = zonedWallTimeToUtc('2026-09-25', 17 * 60 + 45, zone);
      expect(zonedDateKey(instant, zone)).toBe('2026-09-25');
      expect(zonedMinuteOfDay(instant, zone)).toBe(17 * 60 + 45);
      expect(zonedClock(instant, zone)).toBe('17:45');
    }
  });

  it('assigns an instant to the local calendar date, not the UTC one', () => {
    // 21:30 UTC on the 24th is already 01:30 on the 25th in Dubai...
    expect(zonedDateKey(new Date('2026-09-24T21:30:00Z'), 'Asia/Dubai')).toBe('2026-09-25');
    // ...but still the 24th in Algiers (22:30).
    expect(zonedDateKey(new Date('2026-09-24T21:30:00Z'), 'Africa/Algiers')).toBe('2026-09-24');
  });

  it('validates IANA zone names', () => {
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('handles calendar-date keys without timezone drift', () => {
    expect(dayOfWeekForDateKey('2026-09-25')).toBe(5); // Friday
    expect(addDaysToKey('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(dateKeysInRange('2026-09-28', '2026-10-02')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('converts between clock strings and minutes', () => {
    expect(clockToMinutes('09:00')).toBe(540);
    expect(clockToMinutes('18:45')).toBe(1125);
    expect(minutesToClock(540)).toBe('09:00');
    expect(minutesToClock(0)).toBe('00:00');
    expect(minutesToClock(null)).toBeNull();
    expect(() => clockToMinutes('25:00')).toThrow();
    expect(() => clockToMinutes('9am')).toThrow();
  });
});
