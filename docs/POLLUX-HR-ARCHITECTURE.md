# Pollux HR — Architecture

Pollux HR is the HR, attendance and payroll system of **POLLUX MOTORS FZE**, Dubai. It
was built by extending the Matajer People Hub codebase — same stack, same security
model, same authentication — rather than by rewriting it. This document is the map;
the design of the two engines that carry most of the logic is in
[ATTENDANCE-DESIGN.md](ATTENDANCE-DESIGN.md) and [PAYROLL-DESIGN.md](PAYROLL-DESIGN.md),
and who may do what is in [PERMISSIONS.md](PERMISSIONS.md). The stage-by-stage plan and
the audit that preceded it are in [POLLUX-HR-MIGRATION-PLAN.md](POLLUX-HR-MIGRATION-PLAN.md).

---

## 1. Stack (unchanged)

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, plain JSX, lucide icons, no UI framework |
| API | Express 4 + TypeScript (strict), Zod validation, pino logging |
| Database | PostgreSQL + Prisma 6 (migrations) |
| Auth | Backend-issued JWT access tokens + rotating, hashed refresh tokens; lockout; rate limits |
| Files | pdfkit (payslips, PDF reports), exceljs (Excel reports), CSV with BOM |
| Tests | Vitest + Supertest against real Postgres · Vitest (frontend) · Playwright (E2E) |

**History.** Pollux HR began as a branch of the
[Matajer People Hub repository](https://github.com/taherfarg/matajer-employee-management-platform), where the original product remains
unchanged on `main`, and moved here with its full commit history. Database changes are
additive migrations: the Matajer tables and columns are all still there.

---

## 2. Backend

### Request pipeline

```
helmet · cors · compression · json → requestId · pino-http → rate limit
  → authenticate        verify the JWT, re-read the user on every request
  → route               Zod-parse params/query/body, no logic
  → service             authorization (services/access.ts), rules, transactions
  → serializer          field by field: what this caller may see
  → error handler       AppError / ZodError / Prisma error → one JSON envelope
```

Responses are `{ data }`, lists `{ data, meta, summary }`, errors
`{ error: { code, message, details?, requestId } }`. A 422 carries per-field messages
(`attendance.lateGraceMinutes: [...]`) that forms map onto inputs.

### Modules (`src/modules`)

| Module | Responsibility |
|---|---|
| `auth` | login, refresh rotation, logout, change password, lockout, temporary passwords (`crypto.randomInt`) |
| `settings` | company settings (public subset for everyone, full policy for HR, updates by ADMIN), public branding |
| `employees`, `departments`, `compensation`, `me` | people, org chart, dated salary history, self-service views |
| `work-locations`, `work-schedules`, `holiday-calendars` | where and when people work |
| `attendance` | check-in/out, day evaluation, board, timesheets, HR corrections |
| `overtime` | from attendance or manual; approval |
| `leave`, `requests` | leave types, holidays, balances (list/generate/adjust), leave/document/profile requests |
| `advances` | salary advances and their instalments |
| `payroll` | periods, calculation, approval, payslips, adjustments (bonuses and deductions) |
| `documents` | employee documents, stored files, downloads |
| `reports` | nine reports as JSON / CSV / Excel / PDF |
| `dashboard` | one endpoint, three views: management, manager, employee |
| `users` | logins and roles |
| `audit`, `notifications` | read-only audit trail; in-app notifications |

### Shared services (`src/services`)

| Service | Purpose |
|---|---|
| `access.ts` | **every** authorization decision |
| `company.ts` | the primary company and its settings (with safe defaults) |
| `work-context.ts` | an employee's resolved schedule, timezone and holiday calendar |
| `timezone.ts` | local dates and wall-clock ↔ UTC, DST-safe, via `Intl` |
| `working-days.ts` | chargeable leave days, half days, holidays skipped |
| `money.ts` | Decimal helpers: `round2`, `round4`, `sum`, `splitEvenly`, `toAmount` (JSON edge only) |
| `payroll-lock.ts` | refuses changes inside an approved payroll month |
| `audit.service.ts`, `notification.service.ts` | append-only audit entries; notifications |

### Pure engines

The rules that decide money and time are pure functions with no database and no clock:
`attendance.engine.ts` (`planDay`, `evaluateDay`), `payroll.engine.ts`
(`calculatePayroll`, `employedFraction`) and `working-days.ts`. Services gather inputs,
call the engine, and store the result. Approval of a payroll re-runs the engine and
refuses if anything changed since review.

---

## 3. Data model

```
LegalEntity (the company) ──1:1── CompanySettings (all policy)
   ├──< Department, WorkLocation, WorkSchedule ──< WorkScheduleDay
   ├──< HolidayCalendar ──< Holiday
   ├──< LeaveType
   ├──< PayrollPeriod ──< PayrollRecord ──< PayrollItem  (snapshots)
   └──< Employee ──── User (optional login)
          ├──< CompensationRecord          dated salary history (never on Employee)
          ├──< AttendanceRecord ──1── OvertimeEntry
          ├──< LeaveBalance, Request ─┬─ LeaveRequestDetail
          │                           ├─ DocumentRequestDetail
          │                           └─ ProfileChangeRequestDetail
          ├──< SalaryAdvance ──< SalaryAdvanceInstallment
          ├──< PayrollAdjustment
          ├──< Document ──1── DocumentFile (bytes + SHA-256, e.g. payslip PDFs)
          └──< EmploymentEvent
AuditLog · Notification · RefreshToken
```

Decisions worth knowing:

1. **One company, kept as `LegalEntity`.** Pollux is one legal entity (UAE, AED,
   Asia/Dubai). The model and API still support more — nothing was deleted — but the UI
   never asks anyone to choose one, and the API resolves the primary company whenever an
   entity is not given. Remote staff are employees of the same company with their own
   timezone, work location, schedule and holiday calendar — not "branches".
2. **Salary stays in `CompensationRecord`.** A generic employee serializer cannot leak
   what the employee row does not hold.
3. **Payroll records are snapshots** of every figure and identity field; payslips are
   generated once, at approval, and stored as files.
4. **Sources link to what paid them.** Overtime entries, adjustments and instalments
   point at the payroll line that consumed them — the guarantee against paying twice.
5. **Stored days only for real events.** Absences are evaluated on read, so a late
   leave approval or a new holiday corrects history without a batch job.

### Migrations

| Migration | Adds |
|---|---|
| `20260829164919_init`, `20260830151027_add_letter_content` | the original Matajer schema (unchanged) |
| `20260925090000_pollux_organisation` | company settings, work locations, schedules, holiday calendars (existing holidays backfilled into one calendar per entity), employee work context, `FIELD` work mode |
| `20260925100000_pollux_attendance` | attendance records, overtime |
| `20260925110000_pollux_payroll` | advances, instalments, payroll periods/records/items, adjustments, document files |
| `20260925120000_pollux_payroll_sources` | source links from overtime, adjustments and instalments to payroll lines |
| `20260925130000_pollux_attendance_start` | `attendanceStartDate` (backfilled to the migration date, so no history becomes "absent") |
| `20260926100000_pollux_onsite_checkin` | On-site check-in: a location's QR code, position, radius, office networks and Wi-Fi name; the verification kept with each check-in and check-out |

---

## 4. Frontend

```
src/
  App.jsx               shell: sidebar by role, breadcrumb top bar, check-in button, notifications
  navigation.js         pages, their groups and which role sees which
  hooks/                useAuth (session + refresh), useRoute (hash router), useResource
                        (loading/error/data, stale-response safe), useCompany (company + reference data)
  api/                  client.js (fetch + bearer + refresh + ApiError), endpoints.js (one function
                        per API call), adapters.js (API → UI shapes)
  lib/                  format.js (dates, money, durations), download.js (authenticated files), events.js
  components/           ui.jsx (DataTable, Modal, Tabs, StatCard, ConfirmDialog, …) + feature components
  pages/                one file per page
```

- **Routing** is a tiny hash router (`#/payroll/<id>`) — no dependency, survives refresh,
  deep-linkable. A page the role may not open falls back to its home page; the API
  refuses the data regardless.
- **One shell, role-aware navigation**: management gets *Dashboard · People · Time ·
  Leave · Payroll · Documents · Reports · Administration* (+ *Me* for their own
  attendance and pay); a manager gets *Home · Me · My team*; an employee *Home · Me*.
- **Profiles** show tabs by the capabilities the API returns for that employee (Overview,
  Personal, Employment, Attendance, Leave, Salary, Advances, Payroll, Documents,
  Timeline) — a hint for the UI, never the permission itself.
- **Money** is formatted, never calculated: the server sends rounded amounts and the UI
  only displays them.
- **Files** behind authentication (payslips, report exports, documents) are fetched with
  the bearer token and handed to the browser as object URLs.
- **Responsive**: under 720 px every `DataTable` becomes a list of cards (each cell labels
  itself), the sidebar becomes a drawer and dialogs become bottom sheets.

---

## 5. Configuration

Backend environment (see `.env.example`): `DATABASE_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `CORS_ORIGINS`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_API_MAX`,
`SEED_DEMO_PASSWORD` (seed only), optional `GOOGLE_API_KEY` (AI letter drafting;
templates are used without it). Everything else — company identity, working week,
grace minutes, overtime rates, payroll proration, advance limits, default schedule and
calendar — is **company settings in the database**, edited on the Company settings page.

Frontend: `VITE_API_URL` for a split deployment; in development Vite proxies `/api`.
`VITE_DEMO_ACCOUNTS=true` keeps the one-click demo logins in a production build, which
otherwise leaves them out.

## 6. Demo data (`prisma/seed.ts`)

POLLUX MOTORS FZE with 7 departments, 4 work locations (Dubai Office, Field – UAE,
Remote – Cairo, Remote – Algiers), 5 schedules, UAE and Egypt holiday calendars,
6 leave types and 14 employees (one offboarded). The previous month's attendance,
overtime, advances and bonuses are generated through the real services; the previous
month's payroll is approved and paid (13 payslip PDFs) and the current month is
calculated. Seven logins: `admin@`, `hr@`, `manager@`, `employee@`,
`layla.mansour@`, `nour.elsayed@`, `amine.benali@pollux.demo`, all with the password
from `SEED_DEMO_PASSWORD` (default `Passw0rd!23` — a demo value, never a production
secret). The brief's worked examples come out exactly: Ahmed's annual leave
30 + 2 − 10 − 3 = **19 available**; his August payslip gross **6,550.00**, deductions
**666.67**, net **5,883.33**; advance **3,000 over 6 × 500**.

For real use, `prisma/setup.ts` (`npm run db:setup`) is the counterpart: the same
company with one work location, one schedule, the UAE's fixed-date holidays and the leave
types, and only the accounts named in `SETUP_ADMINS`, `SETUP_HR`, `SETUP_MANAGERS` and
`SETUP_EMPLOYEES`. Credentials come from the environment, never from the repository. It
runs as one transaction and will not replace real people unless `SETUP_ALLOW_WIPE=yes`.

## 7. Testing

| Suite | Where | Run |
|---|---|---|
| Backend integration (real Postgres) | `Employee Management Platform BackEnd/tests` | `npm test` with `TEST_DATABASE_URL` |
| Frontend unit | `Employee Management Platform FrontEnd/tests` | `npm test` |
| End to end (real browser, real API, real DB) | `e2e/tests` | `npm test` in `e2e` (migrates and seeds its own `pollux_e2e` database) |

The E2E flows cover the brief's list: employee attendance, leave request, salary advance
request, HR payroll, employee payslip, plus security boundaries and phone layouts.
