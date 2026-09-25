# Pollux HR — Attendance Design

How a check-in becomes *Present*, *Late*, *Partial*, *Absent* or *Missing check-out* —
for someone at the Dubai office, in the field, or working remotely from Cairo or Algiers.

Code: [`attendance.engine.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/attendance/attendance.engine.ts)
(the pure rules) ·
[`attendance.days.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/attendance/attendance.days.ts)
(stored + virtual days) ·
[`attendance.service.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/attendance/attendance.service.ts) ·
[`services/work-context.ts`](../Employee%20Management%20Platform%20BackEnd/src/services/work-context.ts) ·
[`services/timezone.ts`](../Employee%20Management%20Platform%20BackEnd/src/services/timezone.ts)

---

## 1. Principles

1. **The server's clock is the only clock.** Check-in and check-out take no time from the
   client; the browser only sends the click. Nobody can check in "at 08:59" from a
   device with a wrong clock.
2. **Store instants in UTC, judge them in local time.** Every check-in is a UTC instant;
   the day it belongs to and whether it was late are decided in the employee's own
   timezone, against their own schedule.
3. **Rules are pure functions.** `planDay` (what the day was supposed to be) and
   `evaluateDay` (what happened) touch no database and no clock, so every rule is tested
   directly: late by 17 minutes, 45 minutes of overtime, a Cairo check-in against a Cairo
   schedule across a DST change.
4. **Nothing is inferred before go-live.** `attendanceStartDate` (Company settings) is
   the first tracked day; earlier days are never marked absent. People whose attendance is
   not tracked (`attendanceTracked = false`, e.g. the General Manager) are never absent.
5. **Policy is data.** Grace minutes, the partial-day threshold, the missing check-out
   margin and every overtime rule live in `CompanySettings`, edited by an administrator
   and audited — nothing is hard-coded.

---

## 2. When and where does this person work?

Resolved once per employee by `loadWorkContext`, used by attendance, leave arithmetic and
payroll alike. Each answer has a fallback chain ending at the company, so an employee
with nothing assigned behaves exactly as before schedules and calendars existed:

| Question | Resolution order |
|---|---|
| Schedule | employee's schedule → company default schedule → company working week (09:00 start, hours from the weekly hours, 1-hour break) |
| Timezone | employee's timezone → work location's timezone → company timezone (`Asia/Dubai`) |
| Holiday calendar | employee's calendar → company default calendar (UAE) → the company's first calendar |

A schedule may carry its own **anchor timezone** ("09:00 Dubai time", for someone abroad
who works Dubai hours); otherwise it is read in the employee's zone ("09:00 local").
Holiday calendars are **assigned, never assumed from the country**: in the seed, Nour
(Cairo) follows the Egyptian calendar, while Amine (Algiers) follows the Pollux UAE
calendar. Holidays flagged "recurs every year" are expanded into every year a range
touches.

Work schedules are reusable (Standard Dubai office, Showroom, Remote Cairo, Remote
Algiers, Part-time): for each weekday a working flag, start, end and break. Assigning one
to many people is one action on the Work schedules page.

---

## 3. What was the day supposed to be — `planDay`

| Day type | When |
|---|---|
| `LEAVE` | approved leave covers the day (a half day keeps it a working day with half the scheduled minutes, and switches off late/early rules) |
| `HOLIDAY` | the day is in the employee's holiday calendar |
| `WEEKEND` | the schedule has no work that weekday |
| `WORKING_DAY` | otherwise — with scheduled start and end as UTC instants for that date in that zone |

Scheduled minutes = span − break. DST is handled by converting the local wall-clock time
of *that date* to UTC (`zonedWallTimeToUtc`), so a Cairo 09:00 start is correct on both
sides of Egypt's clock change.

## 4. What happened — `evaluateDay`

Policy defaults (all editable): late grace 10 min · early-leave grace 10 min · partial day
below 50% of scheduled minutes · missing check-out 120 min after the shift · overtime
minimum 30 min.

**No check-in**

| Situation | Status |
|---|---|
| Holiday / rest day / leave | `HOLIDAY` / `WEEKEND` / `ON_LEAVE` |
| Attendance not tracked for this person, or before `attendanceStartDate` | `NOT_TRACKED` (never absent) |
| A future day, or today before start + grace | `SCHEDULED` |
| Today, after start + grace | `NOT_CHECKED_IN` |
| Today after the shift has ended, or any past working day | `ABSENT` — 1 day (½ if the other half was approved leave) |

**Checked in, not out**

| Situation | Status |
|---|---|
| Open, within the shift + margin | `PRESENT`, or `LATE` if check-in was after start + grace (the late minutes count from the scheduled start) |
| The shift ended more than *margin* ago, the day has passed, or open for over 20 hours | `MISSING_CHECKOUT` |

**Checked in and out**

| Measure | Rule |
|---|---|
| Worked minutes | span − break (the break is deducted on a working day when the span covers at least half the shift; on a rest day after 6 hours) |
| Late | minutes after the scheduled start, if beyond the grace |
| Early leave | minutes before the scheduled end, if beyond the grace |
| Overtime | minutes after the scheduled end (+ minutes before the start if early arrival counts); on a rest day or holiday every worked minute; ignored below the minimum; only for overtime-eligible employees |
| Status | `PARTIAL` when worked < threshold % of scheduled; else `LATE` when late; else `PRESENT` |

HR can override a status (e.g. a field visit recorded as `PRESENT`); the override is kept
separately (`statusOverridden`) and never recomputed away.

## 5. Stored days and virtual days

Only real events are stored: a check-in, a manual HR record, a correction. Every other day
is **evaluated on read** from the plan: a list of a month for Ahmed shows stored days and
virtual ones (`isVirtual: true`) side by side, so absences need no nightly job and
change automatically when a leave is approved or a holiday is added. Payroll counts
absence only for days before today.

A stored record keeps a snapshot of its timezone and schedule times, so a later schedule
change never rewrites a past day. Completed days keep their stored evaluation; open days
are re-evaluated against the current time.

---

## 6. Check-in and check-out

`POST /attendance/check-in` and `/check-out`, from the Home card, the top-bar button or
My attendance (web or phone).

- Refused on a day of approved leave ("withdraw or change that leave first").
- One record per person per local day: a second check-in is refused with a clear message.
- A check-out closes today's open record — or yesterday's forgotten one, with a notice.
- Refused when the date is inside an approved payroll month (the month lock).
- Working on a rest day or holiday is allowed and produces rest-day overtime.

## 7. Corrections — HR only, always audited

`POST /attendance` (record a missing day), `PATCH /attendance/:id` (fix times or status)
and `POST /attendance/recalculate` (re-evaluate a range after a policy or schedule
change) are HR-only (`assertCanManageAttendance`). Every correction **requires a reason**,
stores who and when on the record, and writes the before/after to the audit trail.
Corrections inside a locked payroll month are refused until an administrator reopens it.

## 8. Overtime from attendance

When a completed day has overtime minutes, an `OvertimeEntry` is created or updated with
the multiplier in force (working day 1.25, rest day/holiday 1.5 by default — frozen on
the entry). With `overtimeRequiresApproval` (default) it waits for HR or the direct
manager; a manager sees minutes, never amounts. Once linked to an approved payroll it can
no longer change.

---

## 9. Who sees what

| | Employee | Manager | HR / Admin |
|---|---|---|---|
| Own day, history, calendar | ✔ | ✔ | ✔ |
| Others' days | ✖ | direct reports | everyone |
| Today board, timesheets | ✖ | direct reports ("Team attendance") | everyone |
| Record / correct / recalculate | ✖ | ✖ | ✔ (reason required, audited) |

## 10. Screens

| Screen | For | Shows |
|---|---|---|
| Home — "Today's attendance" card + top-bar button | everyone with an employee record | local date and time, schedule, worked, late, one-tap check-in/out |
| My attendance | everyone | month calendar, day list, totals |
| Attendance → Today | HR (company), manager (team) | every person's status now, in their own timezone, counts, missing check-outs |
| Attendance → Register | HR | stored records with filters; correct or record a day |
| Timesheets | HR, manager | worked, late, absent and overtime per person for a period |
| Work schedules | HR | the reusable schedules and who follows which |

## 11. Tested

| Suite | Covers |
|---|---|
| `tests/attendance-engine.test.ts` | every rule of `planDay`/`evaluateDay` in isolation |
| `tests/timezone.test.ts` | local dates and DST (Dubai, Cairo, Algiers) |
| `tests/attendance.test.ts` | check-in/out end to end, one record per day, leave and lock refusals, corrections with reasons and audit, virtual days, `attendanceStartDate`, who sees what |
| `e2e/tests/attendance.spec.js` | a remote employee checks in and out from the browser in Africa/Algiers; employees cannot board or correct; HR corrections need a reason |
