# Pollux HR — Frontend

The React 19 + Vite frontend of **Pollux HR** for POLLUX MOTORS FZE. Everything it shows
comes from the sibling Express/PostgreSQL API; every permission is enforced there, and the
frontend only hides what the API would refuse anyway.

## Demo accounts

All seeded accounts use `Passw0rd!23` (the seed's `SEED_DEMO_PASSWORD` default — demo
only). In development the login page has one-click fillers for the first four. A
production build leaves them out, because a deployment set up with real accounts
(`npm run db:setup`) has no demo logins, unless it is built with `VITE_DEMO_ACCOUNTS=true`.

| Role | Email |
|---|---|
| Administrator | `admin@pollux.demo` |
| HR | `hr@pollux.demo` |
| Manager | `manager@pollux.demo` |
| Employee | `employee@pollux.demo` |
| Employees (field, remote Cairo, remote Algiers) | `layla.mansour@`, `nour.elsayed@`, `amine.benali@pollux.demo` |

## Run locally

Start the backend first (see its README), then:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://localhost:4000`, so no
environment variable is needed locally. `npm run build` produces `dist/`.

| Variable | Use |
|---|---|
| `VITE_API_URL` | Absolute API base (including `/api/v1`) for a split deployment; add the frontend origin to the backend's `CORS_ORIGINS` |
| `VITE_PROXY_TARGET` | Where the dev proxy forwards `/api` (default `http://localhost:4000`) |
| `VITE_DEMO_ACCOUNTS` | `true` shows the one-click demo logins in a production build (always shown in development) |

## What each role sees

| Role | Navigation |
|---|---|
| Administrator / HR | **Dashboard** · **People**: Employees, Departments, Work locations · **Time**: Attendance, Timesheets, Work schedules, Overtime · **Leave**: Requests, Leave balances, Holidays · **Payroll**: Payroll runs, Salary advances, Bonuses & deductions, Payslips · Documents · Reports · **Administration**: Users & roles, Audit logs, Company settings · **Me**: own attendance, requests, pay, profile |
| Manager | Home · **Me**: My attendance, My requests, My pay, My documents, My profile · **My team**: Team, Team attendance, Approvals, Overtime, Reports (team reports only — never pay) |
| Employee | Home · **Me**: My attendance, My requests, My pay, My documents, My profile |

Company settings can be changed by an administrator only; HR sees them read-only. There
is no legal-entity page: Pollux is one company, and the entity lives on in the database
and API only.

## Structure

```text
src/
├── App.jsx            shell: role navigation, breadcrumb top bar, check-in button,
│                      notifications, password change; maps routes to pages
├── navigation.js      every page, its group and which role sees it
├── hooks/             useAuth (session, refresh), useRoute (hash router: #/page/param),
│                      useResource (loading/error/data, stale-safe), useCompany (company +
│                      departments, locations, schedules, calendars)
├── api/               client.js (tokens, single-flight refresh, ApiError with field
│                      errors), endpoints.js (one function per API call), adapters.js
├── lib/               format.js (dates, money, durations), download.js (files behind
│                      auth), events.js (tiny change bus between widgets)
├── components/        ui.jsx (DataTable, Modal, Tabs, StatCard, ConfirmDialog, …) and
│                      feature components (attendance, leave, payroll, advances, profile…)
├── pages/             one file per page
└── styles.css         the Pollux design system (tokens, components, responsive rules)
```

- **Money is displayed, never calculated.** Amounts arrive rounded from the server and
  are only formatted (`AED 5,883.33`).
- **Dates from the API are calendar days** and never shift across timezones; attendance
  times are shown in each person's own timezone, as the server computed them.
- **Files behind authentication** (payslips, report exports, documents) are fetched with
  the bearer token and opened or saved as object URLs.
- **Phones**: under 720 px every table becomes a list of cards, the sidebar becomes a
  drawer, and dialogs become bottom sheets. Check-in is on the home screen.
- **Dialogs stack** (an approval over a detail view) with unique accessible names;
  Escape closes the top one.

## Tests

```bash
npm test        # 54 unit tests: API client, adapters, formatting, role navigation, audit diff, demo logins
npm run build
```

The UI is exercised end to end by the Playwright suite in [`../e2e`](../e2e): attendance,
leave, salary advance, payroll and payslip flows, permission boundaries and phone layouts
against the real API and database.

See the [backend README](../Employee%20Management%20Platform%20BackEnd/README.md) for the
API, and [`../docs`](../docs) for the design documents.
