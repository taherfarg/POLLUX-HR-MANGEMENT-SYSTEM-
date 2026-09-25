/**
 * Timezone arithmetic for attendance.
 *
 * The rule the whole attendance module follows: **instants are stored in UTC,
 * and calendar meaning is derived in the employee's timezone.** A check-in is a
 * point in time; which "day" it belongs to and whether it was late are answers
 * that depend on where the employee works. 09:00 in Cairo and 09:00 in Dubai are
 * different instants, and both are on time for a 09:00 schedule read locally.
 *
 * Built on `Intl.DateTimeFormat` rather than a date library: the runtime ships a
 * full IANA database, and the one non-trivial operation - turning a local wall
 * time into an instant across a DST change - is a few lines that are tested
 * directly (Africa/Cairo observes DST; Asia/Dubai and Africa/Algiers do not).
 */

export const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when the runtime knows the zone, e.g. `Asia/Dubai`. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of an instant in a zone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some engines render midnight as 24 even with h23; normalise it.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of the zone from UTC at that instant, in minutes (Dubai = +240). */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecondInstant = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSecondInstant) / MS_PER_MINUTE);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The local calendar date of an instant in a zone, as YYYY-MM-DD. */
export function zonedDateKey(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes after local midnight of an instant in a zone. */
export function zonedMinuteOfDay(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * The instant at which the wall clock in `timeZone` reads `minuteOfDay` on
 * `dateKey`.
 *
 * Guess the offset at the naive UTC reading, then correct once with the offset
 * at the corrected instant - that second step is what makes it right on the day
 * a DST transition happens. For a wall time that does not exist (the skipped
 * hour of a spring-forward) the result lands just after the gap, which is the
 * conventional answer.
 */
export function zonedWallTimeToUtc(dateKey: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * MS_PER_MINUTE;
  const firstOffset = timeZoneOffsetMinutes(new Date(naive), timeZone);
  let result = naive - firstOffset * MS_PER_MINUTE;
  const secondOffset = timeZoneOffsetMinutes(new Date(result), timeZone);
  if (secondOffset !== firstOffset) {
    result = naive - secondOffset * MS_PER_MINUTE;
  }
  return new Date(result);
}

/** Day of week for a calendar date, 0 = Sunday. Pure calendar arithmetic. */
export function dayOfWeekForDateKey(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

/** Calendar-date addition on YYYY-MM-DD keys. */
export function addDaysToKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Every date key in an inclusive range. */
export function dateKeysInRange(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  for (let key = fromKey; key <= toKey; key = addDaysToKey(key, 1)) {
    keys.push(key);
  }
  return keys;
}

/** "HH:mm" for minutes after midnight. */
export function minutesToClock(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  const normalised = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(normalised / 60))}:${pad(normalised % 60)}`;
}

/** Minutes after midnight for "HH:mm". Throws on malformed input. */
export function clockToMinutes(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) throw new Error(`Invalid time "${clock}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${clock}"`);
  return hours * 60 + minutes;
}

/** Local "HH:mm" reading of an instant in a zone. */
export function zonedClock(instant: Date | null | undefined, timeZone: string): string | null {
  if (!instant) return null;
  return minutesToClock(zonedMinuteOfDay(instant, timeZone));
}

/** Whole minutes between two instants (b - a), never negative. */
export function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / MS_PER_MINUTE));
}
