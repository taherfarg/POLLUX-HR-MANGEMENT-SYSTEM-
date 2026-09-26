# Pollux HR — Backend

REST API and data layer of **Pollux HR**, the HR, attendance and payroll system of
POLLUX MOTORS FZE, Dubai. Express + TypeScript + PostgreSQL (Prisma), with backend-owned
JWT authentication.

Design documents: [architecture](../docs/POLLUX-HR-ARCHITECTURE.md) ·
[attendance](../docs/ATTENDANCE-DESIGN.md) · [payroll](../docs/PAYROLL-DESIGN.md) ·
[permissions](../docs/PERMISSIONS.md).

---

## Contents

- [Quick start](#quick-start)
- [Environment](#environment)
- [Stack and why](#stack-and-why)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Permissions and privacy](#permissions-and-privacy)
- [API reference](#api-reference)
- [AI letter drafting](#ai-letter-drafting)
- [Demo data and accounts](#demo-data-and-accounts)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Quick start

Requirements: Node 20+, Docker (for Postgres).

```bash
npm install
cp .env.example .env
npm run db:up
npx prisma migrate deploy && npm run db:seed
npm run dev
```

The API is then on `http://localhost:4000`, with a health check at `/health` and the
route index at `/api/v1`.

```bash
curl -X POST http://localhost:4000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"admin@pollux.demo","password":"Passw0rd!23"}'
```

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled output |
| `npm run typecheck` | TypeScript with no emit |
| `npm test` | Full test suite (needs the test database) |
| `npm run db:up` / `db:down` | Start / stop the Postgres containers |
| `npm run db:migrate` | Create and apply a migration after a schema change |
| `npm run db:seed` | Load the Pollux demo data (replaces existing demo data) |
| `npm run db:setup` | Clean start for real use: the company's configuration and only the accounts in `SETUP_ADMINS`, `SETUP_HR`, `SETUP_MANAGERS`, `SETUP_EMPLOYEES` (see [`prisma/setup.ts`](prisma/setup.ts) and [DEPLOYMENT.md, step 4a](../DEPLOYMENT.md#4a-your-company-dbsetup)) |
| `npm run db:reset` | Drop, re-migrate and re-seed the **development** database |
| `npm run db:studio` | Prisma Studio, a browser UI over the data |

`docker compose` starts two databases: development on port **5433** and a throwaway test
database on **5434**, so `npm test` can never touch the demo data.

---

## Environment

Validated by Zod at boot ([`src/config/env.ts`](src/config/env.ts)); an invalid value
stops the process with a readable message.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Any Postgres |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | ≥ 32 characters, different; the app refuses to start in production on the development placeholders |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL_DAYS` | no | `15m` / `7` |
| `CORS_ORIGINS` | no | Comma-separated browser origins |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_API_MAX` | no | Per IP: 10 sign-in attempts per 15 min / 300 requests per minute |
| `SEED_DEMO_PASSWORD` | no | Password of the seeded demo logins (default `Passw0rd!23`, demo only) |
| `GOOGLE_API_KEY` | no | AI letter drafting; templates are used without it |
| `LOG_LEVEL`, `PORT`, `NODE_ENV` | no | |

Company policy is **not** configured here: working week, grace minutes, overtime rates,
payroll proration, advance limits, default schedule and calendar are company settings in
the database (`GET/PATCH /settings/company`).

---

## Stack and why

| Choice | Reason |
|---|---|
| **TypeScript + Express 4** | Ordinary middleware and functions; nothing to explain but the code itself |
| **PostgreSQL + Prisma 6** | Deeply relational data; constraints and transactions do real work; one schema file doubles as the readable data model; a real migration history |
| **Zod** | One schema per endpoint, types inferred from the same declaration |
| **Backend-owned JWT** | Users, bcrypt hashes and tokens live in the API; authorization is code that can be read and tested, not vendor configuration |
| **Decimal money** | `Prisma.Decimal` end to end; JavaScript numbers only at the JSON edge |
| **pdfkit, exceljs** | Payslips and report exports generated server-side |
| **Vitest + Supertest** | Supertest mounts the real app; tests hit a real database, not mocks |

---

## Architecture

```
Request
  ├─ helmet · cors · compression · body parsing
  ├─ requestId · structured logging · rate limiting
  ├─ authenticate       verifies the JWT, then re-reads the user every request
  ├─ route              parses input with Zod, no business logic
  ├─ service            authorization, business rules, transactions
  ├─ serializer         decides which fields the caller may see
  └─ errorHandler       one place where an error becomes a response
```

```
src/
├── app.ts, server.ts, routes.ts
├── config/  db/  common/  middleware/
├── services/          access rules, company settings, work context (schedule / timezone /
│                      calendar), timezone maths, working days, money, payroll lock,
│                      audit, notifications
└── modules/
    ├── auth/  users/                         sign-in, sessions, logins and roles
    ├── settings/                             company settings, public branding
    ├── employees/  departments/  compensation/  me/  legal-entities/
    ├── work-locations/  work-schedules/  holiday-calendars/
    ├── attendance/  overtime/                engine + service
    ├── leave/  requests/                     types, holidays, balances; the approval engine
    ├── advances/  payroll/                   advances, payroll engine, payslips, adjustments
    ├── documents/  reports/  dashboard/  notifications/  audit/  ai/
```

**Cross-cutting decisions.**
- The authenticate middleware re-reads the user on every request, so a deactivated
  account or changed role takes effect immediately.
- Refresh tokens are stateful, HMAC-stored and rotate on every use; replaying a used one
  revokes the whole family.
- Auditing and notifications never fail the action they describe; when the change runs in
  a transaction, the audit row joins it.
- Success is `{ data, meta?, summary? }`; failure is
  `{ error: { code, message, details?, requestId } }`, with 422 details shaped
  `{ "section.field": [messages] }`.
- Financial operations run in `prisma.$transaction`. Attendance, leave and payroll rules
  are pure functions (`attendance.engine.ts`, `payroll.engine.ts`, `working-days.ts`).

---

## Data model

See [the architecture document](../docs/POLLUX-HR-ARCHITECTURE.md#3-data-model) for the
diagram. The key points:

1. **One company, kept as `LegalEntity`** (POLLUX MOTORS FZE, AE, AED, Asia/Dubai) with
   its policy in `CompanySettings`. The model still supports more entities; the API
   resolves the primary company when none is given.
2. **Work context per employee** — work location, schedule, timezone, holiday calendar —
   each with a fallback to the company default.
3. **`User` and `Employee` are separate**: not everyone needs a login, and an offboarded
   person keeps their record while losing access.
4. **Compensation lives in its own dated table**, so the employee serializer cannot leak
   salary.
5. **Attendance stores real events only**; absences are evaluated on read.
6. **Payroll records are snapshots**, their items link back to the overtime, adjustments
   and instalments they paid, and payslip PDFs are stored bytes (`DocumentFile`).
7. Money is `Decimal(12,2)` (rates `Decimal(12,4)`), never a float.

The schema is [`prisma/schema.prisma`](prisma/schema.prisma). Migrations are additive:
the two original ones are unchanged and five Pollux migrations add the rest, with SQL
backfills.

---

## Permissions and privacy

Four roles — `ADMIN`, `HR_ADMIN`, `MANAGER`, `EMPLOYEE` — and every decision in
[`src/services/access.ts`](src/services/access.ts). The full matrix is in
[docs/PERMISSIONS.md](../docs/PERMISSIONS.md). In short: HR and administrators manage
people and payroll; a manager sees their team's working context (attendance, leave,
overtime minutes) and **never** pay; employees see their own record, attendance,
requests, payslips and advances; only an administrator changes company settings, grants
HR/admin roles or reopens an approved payroll; nobody decides their own request,
overtime, advance or payroll; restricted fields are absent from responses, not `null`.

---

## API reference

Base path `/api/v1`. All routes except `/health`, `/public/branding`, `/auth/login` and
`/auth/refresh` require `Authorization: Bearer <accessToken>`. *HR* below means ADMIN or
HR_ADMIN.

<details>
<summary><b>Auth, users and settings</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| POST | `/auth/login` · `/auth/refresh` · `/auth/logout` | Access + rotating refresh tokens |
| GET | `/auth/me` | Current user and linked employee |
| POST | `/auth/change-password` | Revokes all other sessions |
| GET | `/public/branding` | No auth: product and company name, logo |
| GET | `/settings/company` | Everyone: public subset. HR: full policy |
| PATCH | `/settings/company` | ADMIN. Sections `company`, `attendance`, `overtime`, `payroll`, `advances`, `defaults`; audited with before/after |
| GET | `/users` | HR. Filters `q`, `role`, `status` (`ACTIVE`, `INACTIVE`, `LOCKED`, `MUST_CHANGE_PASSWORD`) |
| GET | `/users/eligible-employees` | HR. Employees without a login |
| POST | `/users` | HR. Creates a login; returns a one-time temporary password. Only ADMIN grants ADMIN/HR_ADMIN |
| PATCH | `/users/:id` | HR. Role, active, scope. Not yourself; not the last admin; ends the person's sessions |
| POST | `/users/:id/reset-password` · `/users/:id/unlock` | HR |
</details>

<details>
<summary><b>People and organisation</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| GET | `/employees` | Directory: `q`, `departmentId`, `workLocationId`, `workMode`, `status`, `employmentType`, `managerId`, `includeOffboarded`, sort, paging |
| POST · PATCH | `/employees`, `/employees/:id` | HR. Work location, schedule, timezone, calendar, overtime eligibility, attendance tracking |
| GET | `/employees/:id` | Field set depends on the caller; includes `capabilities` for the UI |
| POST | `/employees/:id/status` | HR. Status change with reason; offboarding disables the login |
| GET | `/employees/:id/timeline` · `/reports` · `/leave-balances` · `/documents` | |
| GET · POST | `/employees/:id/compensation` | Self or HR to read (HR reading is audited); HR to write |
| GET · POST · PATCH | `/departments` | |
| GET · POST · PATCH | `/work-locations`, `GET /work-locations/distribution` | Dubai Office, Field, Remote… with timezone |
| GET · POST · PATCH | `/work-schedules`, `GET /work-schedules/:id`, `POST /work-schedules/:id/assign` | Per-day start, end, break; bulk assignment |
| GET · POST · PATCH | `/holiday-calendars` | UAE default; others assigned per employee |
| GET · POST · PATCH | `/legal-entities` | Kept for internal use; not in the Pollux UI |
</details>

<details>
<summary><b>Attendance and overtime</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| POST | `/attendance/check-in` · `/attendance/check-out` | Self. Server time; one record per local day; refused on leave or in a locked month |
| GET | `/attendance/today` · `/me/attendance/today` | Own day with schedule, status, can check in/out |
| GET | `/me/attendance` | Own days (stored + evaluated) for a range, with totals |
| GET | `/attendance` | List: self, manager's team, or HR's scope |
| GET | `/attendance/board` | Manager (team) or HR: today, per person, in their timezone |
| GET | `/attendance/timesheet` · `/attendance/summary` | Manager (team) or HR |
| POST | `/attendance` | HR. Record a missing day (reason required) |
| PATCH | `/attendance/:id` | HR. Correct times/status (reason required, audited) |
| POST | `/attendance/recalculate` | HR. Re-evaluate a range after a policy or schedule change |
| GET · POST | `/overtime` | List by scope; HR adds a manual entry |
| POST | `/overtime/:id/approve` · `/reject` · `/cancel` | HR or the direct manager; never your own |
</details>

<details>
<summary><b>Leave and requests</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| GET · POST · PATCH | `/leave/types` | `?includeInactive=true` for HR |
| GET · POST · PATCH · DELETE | `/leave/holidays` | `calendarId`, `year` (recurring holidays included) |
| GET | `/leave/calendar?from=&to=` | Shared absence calendar; reasons hidden from colleagues |
| GET | `/leave/balances` | HR (scope), manager (self + team), employee (own); totals included |
| POST | `/leave/balances/generate` | HR. A year's balances, with carry-over and pro-rating |
| PATCH | `/leave/balances/:id` | HR. Entitlement / carried days with a reason; never below used + pending |
| GET | `/requests` | Unified inbox with per-status `summary` |
| POST | `/requests/leave/preview` | Chargeable days from the employee's schedule and calendar |
| POST | `/requests/leave` · `/requests/document` · `/requests/profile-change` | HR may pass `employeeId` to file for someone in scope; for leave, the notice period then does not apply, so an absence that has already started can be recorded |
| GET | `/requests/:id` | |
| POST | `/requests/:id/approve` · `/reject` · `/cancel` | HR or the direct manager decide (never the requester); reject needs a reason |
</details>

<details>
<summary><b>Pay: advances, payroll, payslips</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| GET · POST | `/advances` | Own (employee, manager) or all in scope (HR); request for self or on someone's behalf (HR) |
| GET | `/advances/:id` | Owner or HR; others 404 |
| POST | `/advances/:id/approve` | HR. Amount, instalments, first month; exact split |
| POST | `/advances/:id/reject` · `/mark-paid` · `/reschedule` · `/cancel` | HR (the owner may withdraw a pending one) |
| GET · POST | `/payroll/periods` | HR |
| GET | `/payroll/periods/:id` | HR. The register (audited) |
| POST | `/payroll/periods/:id/calculate` · `/review` · `/approve` · `/mark-paid` · `/cancel` | HR. Four-eyes on approve |
| POST | `/payroll/periods/:id/reopen` | ADMIN, with a reason; APPROVED only |
| GET | `/payroll/records/:id` | Owner or HR |
| GET · POST | `/payroll/adjustments` | HR. Bonuses, commissions, deductions… |
| POST | `/payroll/adjustments/:id/approve` · `/reject` · `/cancel` | HR; not the person who entered it |
| GET | `/payslips` | Own payslips (HR: all in scope) from approved payrolls |
| GET | `/payslips/:id/pdf` | Owner or HR. The stored PDF; `?download=1` for an attachment |
</details>

<details>
<summary><b>Documents, reports, dashboard, audit</b></summary>

| Method | Path | Who / notes |
|---|---|---|
| GET | `/documents` | HR library: `category`, `employeeId`, `expiring`, `q`; summary of expiring/expired |
| GET | `/documents/:id` | Letter body (EN + AR). Owner or HR |
| GET | `/documents/:id/download` | Stored file (e.g. a payslip). Owner or HR |
| DELETE | `/documents/:id` | HR; payslips cannot be deleted |
| GET | `/reports` | The catalogue for the caller (a manager gets team reports only) |
| GET | `/reports/:type?format=json\|csv\|xlsx\|pdf` | `attendance`, `late`, `absence`, `overtime`, `leave`, `leave-balance`, `payroll`, `advances`, `employees`; filters `from`, `to`, `year`, `employeeId`, `departmentId`, `workLocationId`, `workMode`, `status`, `periodId`. Exports audited |
| GET | `/dashboard` | Management, manager or employee view by role |
| GET | `/dashboard/alerts` · `/dashboard/compensation-overview` | HR |
| GET | `/me/profile` · `/me/timeline` · `/me/leave-balances` · `/me/documents` · `/me/requests` · `/me/team` · `/me/dashboard` | From the token — no id to tamper with |
| GET · POST | `/notifications`, `/notifications/:id/read`, `/notifications/read-all` | |
| GET | `/audit-logs` | HR, read-only: `action`, `entityType`, `entityId`, `actorUserId`, `from`, `to`, `q` |
</details>

---

## AI letter drafting

When a document request is approved, the letter is drafted by Google Gemini in English
and Arabic from the employee's record — or by deterministic templates when no
`GOOGLE_API_KEY` is set, which is the default and works identically. Salary reaches the
prompt only when the employee asked for it to be stated; output is schema-constrained
and re-validated, and a draft introducing an unauthorised amount falls back to the
template. Implementation: [`src/modules/ai/letter.service.ts`](src/modules/ai/letter.service.ts).

---

## Demo data and accounts

`npm run db:seed` builds POLLUX MOTORS FZE: 7 departments, 4 work locations (Dubai
Office, Field – UAE, Remote – Cairo, Remote – Algiers), 5 work schedules, the UAE and
Egypt holiday calendars, 6 leave types and 14 employees. Attendance from the start of the
previous month, overtime, leave, advances and bonuses are produced **through the real
services**; the previous month's payroll is approved and paid (payslip PDFs stored) and
the current month is calculated.

| Role | Email | Who |
|---|---|---|
| ADMIN | `admin@pollux.demo` | Khalid Al Mansoori, General Manager (attendance not tracked) |
| HR_ADMIN | `hr@pollux.demo` | Sara Haddad, HR Manager |
| MANAGER | `manager@pollux.demo` | Youssef Karim, Sales Manager — Ahmed, Layla and Daniel report to him |
| EMPLOYEE | `employee@pollux.demo` | Ahmed Nabil, Sales Executive |
| EMPLOYEE | `layla.mansour@pollux.demo` | Layla Mansour, field sales |
| EMPLOYEE | `nour.elsayed@pollux.demo` | Nour El-Sayed, remote in Cairo (Egypt calendar) |
| EMPLOYEE | `amine.benali@pollux.demo` | Amine Benali, remote in Algiers (UAE calendar) |

Password: `SEED_DEMO_PASSWORD` (default `Passw0rd!23` — never a production secret).
The brief's examples are reproduced exactly: Ahmed's annual leave 30 + 2 − 10 − 3 = 19;
his August payslip gross 6,550.00, deductions 666.67, net 5,883.33; an advance of 3,000
over 6 × 500. All names and figures are invented and the `.demo` domain does not resolve.

### Real use: `db:setup`

`npm run db:setup` ([`prisma/setup.ts`](prisma/setup.ts)) clears the database and creates
POLLUX MOTORS FZE with one work location, one Monday-to-Friday schedule, the UAE's
fixed-date holidays, the leave types above with this year's balances, and an employee and
login for each account in `SETUP_ADMINS`, `SETUP_HR`, `SETUP_MANAGERS` and
`SETUP_EMPLOYEES` (entries `Full name|email|password|Job title|YYYY-MM-DD`, separated by
`;`). The accounts come from the environment so real credentials never enter the
repository. It needs only `DATABASE_URL`, no JWT secrets. It runs as one transaction and
refuses to replace real (non-`.demo`) people unless `SETUP_ALLOW_WIPE=yes`. With a single
HR/administrator account it turns the separate payroll approver off, and attendance is
tracked from the day after setup. Walkthrough: [DEPLOYMENT.md, step 4a](../DEPLOYMENT.md#4a-your-company-dbsetup).

---

## Testing

```bash
TEST_DATABASE_URL=postgresql://ems:ems_local_password@localhost:5434/ems_test?schema=public npm test
```

**293 tests across 15 files**, against a real PostgreSQL test database:

| File | Covers |
|---|---|
| `access-control.test.ts` | The privacy matrix — would catch a serializer regression or a dropped check |
| `auth.test.ts` | Login, refresh rotation and replay detection, lockout, password change, deactivation |
| `employees.test.ts` | Creation, update with timeline and audit, status changes, search, compensation |
| `request-workflows.test.ts` | Leave, document and profile workflows; balance hold/deduct/release |
| `letters.test.ts` | Letter templates, salary guard, AI fallback |
| `organisation.test.ts` | Company settings, work locations, schedules, calendars, employee-aware leave arithmetic |
| `attendance-engine.test.ts` · `timezone.test.ts` | Every attendance rule; DST-safe local time |
| `attendance.test.ts` | Check-in/out, corrections, overtime, board, locking, who sees what |
| `payroll-engine.test.ts` | The pure payroll calculation |
| `payroll.test.ts` | Advances, adjustments, the payroll lifecycle, four-eyes, locking, payslips |
| `administration.test.ts` | Users & roles, leave balances, reports, document library, dashboards per role |
| `clean-start.test.ts` | `db:setup`: reading the accounts, the result, sign-in, single-approver payroll, the wipe guard |
| `report-export.test.ts` | CSV/Excel/PDF writers, formula-injection neutralising |
| `working-days.test.ts` | Leave day counting |

---

## Deployment

The only coupling to a database host is `DATABASE_URL`. The included `Dockerfile` is a
multi-stage build that runs as a non-root user and applies pending migrations
(`prisma migrate deploy`) before accepting traffic; all Pollux migrations are additive
and backfill existing data. A Render blueprint is in [`../render.yaml`](../render.yaml)
with a walkthrough in [`../DEPLOYMENT.md`](../DEPLOYMENT.md). Load the data once from a
checkout against the hosted database (the production image ships compiled code only):
`npm run db:setup` for real use, or `npm run db:seed` for the demo. Generate real JWT secrets with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

---

## Known limitations

- **Documents other than payslips are metadata plus letter text** — no general upload.
- **No GPS or geofencing** on check-in; the location is the assigned work location.
- **No WPS/SIF bank file** yet; payment is recorded with a reference.
- **End-of-service gratuity** is not calculated.
- **Public holidays are illustrative** — Islamic dates move with lunar observation.
- **Rate limiting is in-process**; several instances would need a shared store.
- **No refresh-token cleanup job**; expired rows are harmless and indexed.
- `npm run db:reset` and `npm run db:seed` replace data — development databases only.
  `npm run db:setup` replaces data too, but refuses to replace real people unless told to.
