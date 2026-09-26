# Pollux HR — Permissions

Who can see and do what, and where each rule is enforced.

Every authorization decision is made by a function in one file,
[`src/services/access.ts`](../Employee%20Management%20Platform%20BackEnd/src/services/access.ts).
Routes add a coarse role gate (`requireAdmin` = ADMIN or HR_ADMIN); the real decision is
made per record inside the service, because rules such as *"a manager may approve for
their team, but never for themselves"* cannot be expressed as a role check on a URL.

The frontend only hides what the API already refuses. Hiding a button is never the
protection: the E2E suite calls the API directly with each role's own token to prove it.

---

## The four roles

| Role | Who at Pollux Motors | In one sentence |
|---|---|---|
| `ADMIN` | General Manager | Everything, including company settings, granting HR/admin roles and reopening an approved payroll |
| `HR_ADMIN` | HR Manager | Runs HR and payroll for the company; cannot change company policy or mint administrators |
| `MANAGER` | Line managers | Their own data plus their direct reports' *working context* — attendance, leave, overtime minutes — never pay |
| `EMPLOYEE` | Everyone else | Their own record, attendance, requests, payslips and advances |

`HR_ADMIN` can still be scoped to one legal entity (`scopedLegalEntityId`) — the API and
tests keep supporting it for a future second company, but the Pollux demo uses an unscoped
HR admin. Every "HR" cell below means *HR within their scope*.

---

## Data access matrix

| Data | Employee | Manager | HR_ADMIN | ADMIN |
|---|---|---|---|---|
| Colleague directory (name, title, department, work email) | ✔ | ✔ | ✔ | ✔ |
| Employee record — personal data (DOB, address, nationality, emergency contact) | own | ✖ (work context only for reports) | ✔ | ✔ |
| **Salary / compensation history** | own | **✖ never** | ✔ (reading someone else's is audited) | ✔ |
| Documents | own (non-confidential) | ✖ | ✔ | ✔ |
| Employment timeline | own | ✖ | ✔ | ✔ |
| Attendance — own | read, check in/out | read, check in/out | read, check in/out | read, check in/out |
| Attendance — others | ✖ | direct reports (read) | read, create, correct (reason required) | same |
| Today board / timesheets | ✖ | direct reports | everyone | everyone |
| Overtime minutes | own | direct reports (approve/reject) | ✔ | ✔ |
| Overtime **amounts** | own | **✖** | ✔ | ✔ |
| Leave requests | own (submit, withdraw) | reports (approve/reject) | ✔ | ✔ |
| Leave balances | own | own + reports | read, generate year, adjust (reason required) | same |
| Holidays, calendars, schedules, locations, departments | read | read | manage | manage |
| A location's on-site check-in rule — QR code, office position, office networks | ✖ (only that a QR code is needed) | ✖ (same) | manage | manage |
| How a check-in was verified (distance, network, IP) | own | ✖ | everyone | same |
| **Salary advances** | own (request, withdraw while pending) | own only — **never the team's** | approve, reject, mark paid, reschedule, cancel | same |
| **Payroll runs, records, adjustments** | ✖ | **✖** | create, calculate, review, approve¹, mark paid, cancel | same, plus **reopen** |
| **Payslips (PDF)** | own | own only | ✔ | ✔ |
| Reports | ✖ | team reports: attendance, late, absence, overtime, leave, leave balance | all nine, incl. payroll, advances, employees | same |
| Dashboard | personal | personal + team (no pay) | company, incl. payroll panel | same |
| Company settings | public subset (name, logo, currency, timezone, week, pay day) | public subset | read full policy | read and **change** |
| Users & roles | ✖ | ✖ | create/manage EMPLOYEE and MANAGER logins | everything |
| Audit logs | ✖ | ✖ | read (scoped HR: own entity only) | read |

¹ Four-eyes: with `payrollRequiresSeparateApprover` on (the default), whoever calculated
the payroll cannot approve it, and whoever entered a bonus or deduction cannot approve it.

---

## Rules worth knowing

| Rule | Where |
|---|---|
| A line manager **never** sees a report's salary, payslip, advance, payroll line or overtime amount | `canViewCompensation`, `canViewPayData`, `canViewOvertimeAmounts` |
| Nobody decides their own request, overtime or advance — including an ADMIN | `assertCanDecideRequest`, `assertCanDecideOvertime`, `assertCanDecideAdvance` |
| Only an ADMIN grants ADMIN or HR_ADMIN; HR creates EMPLOYEE/MANAGER logins only | `assertCanAssignRole` |
| Nobody changes their own role or deactivates themselves; the last active ADMIN cannot be removed | `users.service.ts` |
| Changing a role, deactivating or resetting a password ends that person's sessions | `users.service.ts` (refresh tokens revoked) |
| Only an ADMIN changes company settings | `assertCanManageCompanySettings` |
| Only an ADMIN reopens an approved payroll; a PAID payroll is final | `assertCanReopenPayroll`, `payroll.service.ts` |
| Attendance corrections are HR-only and need a reason; the before/after goes to the audit trail | `assertCanManageAttendance`, `attendance.schema.ts` |
| A month with an approved payroll is locked: attendance, overtime, advances and adjustments in it can no longer change | `assertPayrollPeriodOpen` (`services/payroll-lock.ts`) |
| An unrelated record answers **404, not 403** — confirming that a reference exists is itself a leak | request, advance and payslip services |
| Reading another person's salary or a payroll register is itself audited (`VIEW_SENSITIVE`); every export is audited (`EXPORT`) | services + `reports.service.ts` |
| Restricted fields are **absent** from responses, not `null` — serializers build responses field by field | `employee.serializer.ts`, `serializeRecord`, … |
| Payslip PDFs are served with `Cache-Control: private, no-store` and only after the same pay-data check | `payroll.routes.ts`, `common/http.ts` |

---

## Where salary can and cannot appear

Salary lives in `CompensationRecord` (dated history) and in payroll snapshots
(`PayrollRecord`, `PayrollItem`). It is **never** a column on `Employee`, so the generic
employee serializer physically cannot leak it. Endpoints that return pay:

| Endpoint | Guard |
|---|---|
| `GET /employees/:id/compensation` | `assertCanViewCompensation` (self or HR) — audited when HR reads someone else's |
| `GET /payroll/*` | `requireAdmin` + `assertCanManagePayroll` |
| `GET /payroll/records/:id` | `assertCanViewPayData` (self or HR) |
| `GET /payslips`, `GET /payslips/:id/pdf` | self or HR; others 404 |
| `GET /advances*` | self or HR; a manager lists only their own |
| `GET /reports/payroll`, `/reports/advances` | HR/ADMIN only (sensitive reports are audited even as on-screen previews) |
| `GET /dashboard` | the payroll panel exists only in the management view; a manager's `team` block carries attendance and leave only |

---

## Tested

| Suite | What it proves |
|---|---|
| `tests/access-control.test.ts`, `administration.test.ts`, `payroll.test.ts`, `attendance.test.ts`, `employees.test.ts` (backend) | every guard above, per role, against a real database |
| `e2e/tests/security.spec.js` | the same boundaries through the running app with each user's own token: employee → colleague pay, manager → team pay, HR → company settings, payslip PDFs, typed URLs |
| `e2e/tests/advances.spec.js`, `leave.spec.js`, `payroll.spec.js` | self-approval refused, managers limited to their team, four-eyes payroll approval |
