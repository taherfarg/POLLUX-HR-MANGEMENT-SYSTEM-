# Pollux HR — Migration Plan

**From:** Matajer People Hub (multi-entity employee management platform)
**To:** Pollux HR — a practical, single-company HR system for **POLLUX MOTORS FZE**, Dubai, UAE

This document was written *before* any code was changed, after a full audit of the
repository (Phase 0). It records what exists, what stays, what changes, and why.

---

## 0. Keeping the original recoverable

| What | Where |
|---|---|
| Original Matajer version | branch `main` at commit `2f0b71e` — untouched |
| Pollux HR version | branch `claude/happy-babbage-yhcq6t`, built on top of `main` |

Nothing is force-pushed and `main` is never modified. `git checkout main` returns the
Matajer product exactly as it was. Every Pollux change is a normal commit, so any
single stage can be inspected or reverted on its own.

The database evolves through **additive Prisma migrations**. The two original
migrations are kept byte-for-byte; the Pollux migrations only add tables, add
nullable columns, add enum values and backfill data. No table is dropped and no
existing column is renamed, so the Matajer data model is still present inside the
Pollux schema.

---

## 1. Audit summary — the current architecture

### Stack (all preserved)

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 8, plain JSX, no router (page state in the shell), lucide icons |
| API | Express 4 + TypeScript (strict), Zod validation, pino logging |
| Database | PostgreSQL + Prisma 6.19 |
| Auth | Backend-issued JWT access tokens (15 min) + rotating, hashed refresh tokens; account lockout; auth rate limit |
| Tests | Vitest + Supertest against a real Postgres (118), frontend Vitest (34), Playwright E2E (38) |

### Request pipeline

```
helmet · cors · compression · json(1mb) → requestId · pino-http → rate limit
  → authenticate (JWT + fresh user read every request)
  → controller (Zod parse, no logic) → service (authorization + rules + transactions)
  → serializer (field-level privacy) → central error handler
```

### Data model (as found)

```
LegalEntity ──┬──< Employee >──── User (1:1 optional)
              │       ├──< CompensationRecord   (dated salary history)
              │       ├──< EmploymentEvent      (timeline)
              │       ├──< Document             (metadata + letter text)
              │       ├──< LeaveBalance
              │       └──< Request ─┬─ LeaveRequestDetail
              │                     ├─ DocumentRequestDetail
              │                     └─ ProfileChangeRequestDetail
              ├──< LeaveType, Holiday
Notification, AuditLog, RefreshToken, Department
```

### Authorization

Every decision lives in `src/services/access.ts` (`isManagement`, `managesEmployee`,
`employeeViewLevel`, `canViewCompensation`, `assertCanDecideRequest`, …). Serializers
build responses field by field, so restricted fields are *absent*, not null. Managers
never see compensation; reading someone else's salary is itself audited; nobody
approves their own request; unrelated requests answer 404.

### Leave engine

`services/working-days.ts` counts chargeable days from the entity work week minus the
entity's holidays, with half-day rules. Submitting leave reserves days as
`pendingDays`; approval moves them to `usedDays`; rejection/withdrawal releases them.
A preview endpoint shows the exact cost (and the skipped holidays) before submitting.

### Findings from the audit

| # | Finding | Severity | Action |
|---|---|---|---|
| F1 | A scoped `HR_ADMIN` can create a login with role `ADMIN` through `POST /employees` (`account.role`) — privilege escalation | **High** | Fix: central `assertCanAssignRole` — only ADMIN may grant ADMIN/HR_ADMIN; scoped HR can only scope to their own entity |
| F2 | `GET /audit-logs` is not entity-scoped: a scoped HR admin reads every entry, including compensation `before`/`after` amounts of other entities | **High** | Fix: `AuditLog.legalEntityId`; scoped HR only sees entries tagged with their entity |
| F3 | `POST /requests/:id/cancel` lets any management user cancel any request, ignoring entity scope | Medium | Fix: cancel requires owner or HR *within scope* |
| F4 | E2E suite signs in ~48 times but the API allows 10 logins / 15 min outside `NODE_ENV=test`, so the suite cannot pass locally | Test infra | Fix: the E2E API server gets its own rate-limit ceiling |
| F5 | `Holiday.isRecurringAnnually` exists but is never applied in calculations | Low | Implemented: recurring holidays are expanded per year |
| F6 | Documents are metadata only — there is no place to store a generated file | Gap | Add `DocumentFile` (bytes + checksum) used by payslip PDFs |

---

## 2. What remains (untouched in behaviour)

- Express app factory, middleware chain, error envelope, rate limiting, logging.
- JWT + refresh-token rotation, lockout, password policy, `/auth/*`.
- `User` ↔ `Employee` separation, the four roles, `services/access.ts` philosophy.
- Employees, departments, compensation history (`CompensationRecord` — salary is
  **not** moved onto `Employee`), employment timeline, documents, notifications,
  audit log (append-only, no update/delete endpoint).
- Leave types, balances, pending reservation, approval/rejection/withdrawal, preview,
  overlap guard, public-holiday exclusion, document letters (template + optional AI),
  profile-change requests.
- `LegalEntity` — kept as the internal owner of currency, timezone, work week,
  holidays, working hours and policy.

## 3. What changes

| Area | Change |
|---|---|
| Branding | "Matajer People Hub" → **Pollux HR**; company **POLLUX MOTORS FZE**; Pollux palette, logo mark, copy; demo domain `pollux.demo` |
| Single company | One primary `LegalEntity` (POLLUX MOTORS FZE, AE, AED, Asia/Dubai). The API resolves it automatically (e.g. `legalEntityId` becomes optional when creating an employee). Entity pickers, entity filters and the multi-entity page leave the normal UI |
| Work location | `WorkMode` gains `FIELD`. New `WorkLocation` (Dubai Office, Remote, Field). Employees get work location, country/city of work, timezone |
| Leave calculation | Becomes **employee-aware**: the employee's own schedule decides working days and their assigned holiday calendar decides holidays. With no schedule/calendar assigned it falls back to the entity work week and default calendar — identical to today's behaviour |
| Holidays | Grouped into `HolidayCalendar`s (existing holidays are backfilled into one calendar per entity). Employees can be assigned a calendar; default is the company calendar |
| Employee profile | Full-page profile with tabs: Overview, Personal, Employment, Attendance, Leave, Salary, Advances, Payroll, Documents, Timeline — each tab shown only when the API grants it |
| Dashboard | Operational cards (present/absent/late today, remote, pending approvals, missing check-outs, document expiry, recent activity) instead of multi-entity charts |
| Navigation | Grouped sidebar: People · Time · Leave · Payroll · Documents · Reports · Administration, plus "My workspace" for everyone with an employee record |

## 4. What is hidden (kept in the database and API)

- The **Legal entities** page and nav item (replaced by *Company Settings*).
- Entity filter in the directory, entity picker in the employee form, entity badges.
- `/legal-entities` endpoints stay (internal use, tests, and a future second company).
- Entity-scoped `HR_ADMIN` stays supported by the API and tests; the Pollux demo simply
  uses an unscoped HR admin.

## 5. What is added

| Module | Purpose |
|---|---|
| Company settings | Attendance, overtime, payroll and leave policy stored in the database (`CompanySettings`, 1:1 with `LegalEntity`) |
| Work locations | Where people work, with timezone |
| Work schedules | Reusable weekly schedules (`WorkSchedule` + `WorkScheduleDay`): per-day start/end/break, optional anchor timezone, assigned per employee with a company default |
| Holiday calendars | UAE default + other calendars, optional per-employee assignment |
| Attendance | Check-in/out, server-side calculations (worked, late, early leave, overtime, absence), today board, history, calendar, timesheets, audited HR corrections |
| Overtime | Auto-created from attendance, manual entries, configurable approval, feeds payroll only once approved |
| Salary advances | Request → approve with instalment plan → mark paid → deducted by payroll → completed |
| Payroll adjustments | Bonus, commission, allowance, deduction, etc. — relational, approved before use |
| Payroll | Monthly periods, snapshot records and line items, `DRAFT → CALCULATED → REVIEWED → APPROVED → PAID`, locking, explicit reopen |
| Payslips | PDF generated from the frozen snapshot, stored as an employee `Document` (+ `DocumentFile` bytes) |
| Reports | Attendance, late, absence, overtime, leave, leave balance, payroll, advances, employees — CSV / Excel / PDF |
| Users & roles | List logins, change role/status (with the F1 rules), create a login for an employee, reset password |

## 6. Database changes

All additive, delivered as Prisma migrations with SQL backfills.

**New enums:** `WorkLocationKind`, `HolidayType`, `AttendanceStatus`, `AttendanceSource`,
`AttendanceDayType`, `OvertimeStatus`, `OvertimeSource`, `SalaryAdvanceStatus`,
`AdvanceInstallmentStatus`, `PayrollStatus`, `PayrollItemKind`, `PayrollItemType`,
`PayrollAdjustmentType`, `PayrollAdjustmentStatus`, `SalaryDayBasis`, `PayBase`.
**Extended enums:** `WorkMode` (+`FIELD`), `AuditAction` (+`CALCULATE`, `REVIEW`,
`MARK_PAID`, `REOPEN`, `EXPORT`), `NotificationType` (+payroll/attendance/advance types).

**New tables:** `company_settings`, `work_locations`, `work_schedules`,
`work_schedule_days`, `holiday_calendars`, `attendance_records`, `overtime_entries`,
`salary_advances`, `salary_advance_installments`, `payroll_periods`, `payroll_records`,
`payroll_items`, `payroll_adjustments`, `document_files`.

**New columns:** `employees.workLocationId`, `workCountryCode`, `workCountry`,
`workCity`, `timezone`, `workScheduleId`, `holidayCalendarId`, `overtimeEligible`;
`holidays.calendarId` (backfilled, then `NOT NULL`), `holidays.type`;
`audit_logs.legalEntityId`.

**Changed constraint:** `holidays (legalEntityId, date)` unique → `(calendarId, date)`
unique. Required so a UAE and an Egypt calendar under the same company can both hold
1 January. The backfill puts every existing holiday into its entity's calendar, so no
existing row can violate the new constraint.

Money is always `Decimal(12,2)` (rates `Decimal(12,4)`), computed with `Prisma.Decimal`
(decimal.js) and rounded half-up to 2 dp per line item. Totals are sums of rounded
lines, so every payslip adds up exactly. Floating point is never used for money.

## 7. API changes

Existing routes keep their paths and response shapes (fields are only added).

| New prefix | Highlights |
|---|---|
| `/settings/company` | read (public subset for everyone, full for management), update (ADMIN) |
| `/public/branding` | company name and logo for the login screen (no auth, nothing sensitive) |
| `/work-locations`, `/work-schedules`, `/holiday-calendars` | CRUD for management; schedules assignable in bulk |
| `/attendance` | `check-in`, `check-out`, `today`, list, `board`, `timesheet`, `calendar`, HR create/correct |
| `/overtime` | list, manual create, approve, reject, cancel |
| `/advances` | request, list, approve (with plan), reject, cancel, mark paid, reschedule |
| `/payroll` | periods (create, calculate, review, approve, mark paid, reopen, cancel), records, adjustments |
| `/payslips` | own payslips / HR list; PDF download |
| `/reports/:type` | JSON, `?format=csv|xlsx|pdf` |
| `/users` | list, create login, update role/status, reset password |
| `/documents` | management list; `/documents/:id/download` for stored files |
| `/leave/holidays/:id` (PATCH), `/leave/balances` | edit holiday; balance list/adjust/generate year |

Business logic lives in services; routes only parse and delegate (the existing style).
Financial operations run in `prisma.$transaction`.

## 8. UI changes

- Pollux branding, calmer visual style (no grain/orbit decoration), grouped sidebar.
- Reusable `DataTable` (table on desktop, cards on phones), `Tabs`, `StatCard`,
  confirm dialogs — every new page is built from the same parts.
- Management pages: Dashboard, Employees (+ tabbed profile), Departments, Work
  Locations, Attendance, Timesheets, Work Schedules, Overtime, Leave requests, Leave
  balances, Holidays, Payroll runs, Salary advances, Bonuses & deductions, Payslips,
  Documents, Reports, Users & roles, Audit logs, Company settings.
- Self-service: Home with a check-in/out card, My attendance, My requests, My pay
  (payslips + advances), My profile (tabbed). Managers add My team (people, team
  attendance, approvals).
- A persistent check-in/check-out control in the top bar for anyone with an employee
  record, including HR and admins.

## 9. Security model (extended, never weakened)

| Data | Employee | Manager | HR_ADMIN | ADMIN |
|---|---|---|---|---|
| Own attendance | read, check in/out | — | — | — |
| Others' attendance | — | direct reports (read) | in scope (read, correct) | all |
| Salary / compensation | own | **never** | in scope | all |
| Payroll & payslips | own payslips | **never** | in scope | all |
| Advances | own (request, read) | **never** | approve, pay | all |
| Overtime | own | approve reports' minutes (no amounts) | all | all |
| Company settings | public subset | public subset | read | read, update |
| Audit log | — | — | own entity | all |

All checks stay server-side in `services/access.ts`; the UI only hides what the API
already refuses.

## 10. Migration risks and mitigations

| Risk | Mitigation |
|---|---|
| Holiday unique-key change could fail on existing data | Backfill assigns one calendar per entity first; existing `(entity, date)` uniqueness implies `(calendar, date)` uniqueness |
| Adding enum values inside a migration | Postgres ≥ 12 allows `ADD VALUE` in a transaction; the new value is not used in the same migration |
| Leave arithmetic changing for existing employees | Employee-aware calculation falls back to the old rule when no schedule/calendar is assigned; the existing leave tests run unchanged |
| Timezone bugs (DST — Egypt observes DST) | Instants stored in UTC; local dates/times derived with `Intl` in one module with DST tests (Cairo, Algiers, Dubai) |
| Historic payroll drifting when salaries change | Payroll records snapshot every figure and identity field; payslips render only from the snapshot; approved/paid periods refuse recalculation |
| Double counting (overtime, instalments, adjustments paid twice) | Each source row links to the payroll item that consumed it; approved periods lock them; reopening releases them in one transaction |
| E2E suite tied to Matajer seed data | Rewritten for the Pollux seed, keeping every original security and workflow assertion that still applies |
| Demo secrets | Seed password comes from `SEED_DEMO_PASSWORD`; no production secrets are committed |

## 11. Implementation order

1. Repository audit ✔ (this document)
2. Pollux branding
3. Single-company UX
4. Work locations · 5. Work schedules · 6–7. Attendance + calculations
8. Leave integration · 9. Salary advances · 10. Overtime
11. Payroll · 12. Payslips · 13. Reports · 14. Dashboard · 15. Company settings
16. Permissions review · 17. Tests · 18. Documentation · 19. Final QA

After each stage: typecheck, backend tests, frontend tests, builds.
