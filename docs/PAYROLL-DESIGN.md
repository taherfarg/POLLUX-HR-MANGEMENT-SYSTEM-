# Pollux HR — Payroll Design

How a month's pay is calculated, checked, approved, paid and shown to the employee —
and why it cannot drift afterwards.

Code: [`payroll.engine.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/payroll/payroll.engine.ts)
(the pure calculation) ·
[`payroll.service.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/payroll/payroll.service.ts)
(gathering, lifecycle, payslips) ·
[`advances.service.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/advances/advances.service.ts) ·
[`adjustments.service.ts`](../Employee%20Management%20Platform%20BackEnd/src/modules/payroll/adjustments.service.ts) ·
[`services/money.ts`](../Employee%20Management%20Platform%20BackEnd/src/services/money.ts)

---

## 1. Principles

1. **Money is never a JavaScript number.** Every amount is a `Prisma.Decimal`
   (decimal.js) from the database to the payslip; columns are `Decimal(12,2)`, rates
   `Decimal(12,4)`. Numbers appear only at the JSON edge, already rounded by the server.
2. **Every line is rounded once, half-up to the cent; totals are sums of rounded lines.**
   A payslip always adds up exactly.
3. **The calculation is a pure function.** `calculatePayroll(input, policy)` touches no
   database and no clock, so the same input always yields the same payslip. That is what
   lets approval re-run it and prove nothing changed.
4. **No hard-coded formulas.** Day basis, deduction base, overtime base and rates,
   standard hours and which deductions apply all come from `CompanySettings`, edited on
   the Company settings page (ADMIN only, audited).
5. **Snapshots, not live joins.** A payroll record stores every figure and identity field
   it was computed from. Payslips render from the snapshot, so a later salary change,
   rename or transfer never alters an issued payslip.
6. **Nothing is paid twice.** Each overtime entry, adjustment and advance instalment is
   linked to the payroll line that consumed it at approval; linked sources are never
   picked up again.

---

## 2. What goes into a payslip

```
  Basic salary                      prorated if employed for part of the month
+ Housing, transport, other allowances  (same proration)
+ Overtime                          approved minutes ÷ 60 × hourly rate × multiplier
+ Bonuses, commissions, allowances, other earnings   (approved adjustments)
- Salary advance instalments        scheduled instalments due this month or earlier
- Unpaid leave                      days × daily rate                  (if enabled)
- Absence                           days × daily rate                  (if enabled)
- Late arrival                      minutes × (daily rate ÷ hours ÷ 60) (if enabled)
- Other deductions                  (approved adjustments)
= Net salary
```

### Inputs, per employee (`gatherPayroll`)

| Input | Source | Rule |
|---|---|---|
| Salary | `CompensationRecord` rows effective in the month | Several records in one month (a raise on the 15th) become **segments**, weighted by days. A salary recorded in another currency is **skipped with a reason**, never converted |
| Employed days | hire / exit date | Partial months are prorated (below) |
| Absent days | attendance engine | Only working days **before today** with no check-in (half a day when the other half is approved leave). Before `attendanceStartDate` nothing is absent |
| Unpaid leave | approved leave of an unpaid type | 1 per full day, 0.5 per half day |
| Late minutes | attendance engine | Only finished days |
| Overtime | `OvertimeEntry` with status `APPROVED`, not yet linked, dated up to the month end | Earlier unpaid months are caught up |
| Adjustments | `PayrollAdjustment` `APPROVED`, not yet linked, payroll month ≤ this month | A late one is labelled "(for 2026-08)" |
| Instalments | `SalaryAdvanceInstallment` `SCHEDULED`, due ≤ this month, advance `PAID`/`ACTIVE` | Oldest first |

### Rates

| Policy (`CompanySettings`) | Values | Effect |
|---|---|---|
| `salaryDayBasis` | `FIXED_30` (default) · `CALENDAR_DAYS` · `WORKING_DAYS` | Divisor for the daily rate: 30, the days in the month, or the employee's scheduled working days |
| `deductionBase` | `BASIC` (default) · `GROSS` | Daily rate = base ÷ divisor, for absence and unpaid leave |
| `overtimeBase` | `BASIC` (default) · `GROSS` | Hourly rate = base ÷ divisor ÷ `standardDailyHours` |
| `overtimeRateMultiplier` / `restDayOvertimeMultiplier` | 1.25 / 1.5 by default | Stored **on each overtime entry** when it is created, so a later policy change does not reprice approved overtime |
| `absenceDeductionEnabled`, `unpaidLeaveDeductionEnabled`, `lateDeductionEnabled` | booleans | Switch each deduction line on or off |

Rates are carried unrounded through the arithmetic; the rounded rate (4 dp) is only stored
for display.

### Proration

A full month is always exactly the full salary — nobody employed all month is paid 28/30
in February. For a partial month:

| Basis | Employed share |
|---|---|
| `FIXED_30` | (30 − calendar days not employed) ÷ 30 |
| `CALENDAR_DAYS` | days employed ÷ days in the month |
| `WORKING_DAYS` | working days employed ÷ working days in the month |

---

## 3. Worked example (seeded)

Ahmed Nabil, Sales Executive, August 2026, company defaults (`FIXED_30`, bases `BASIC`,
8-hour day, overtime ×1.25):

| Line | Calculation | Amount (AED) |
|---|---|---|
| Basic salary | | 5,000.00 |
| Housing allowance | | 500.00 |
| Transport allowance | | 500.00 |
| Overtime (2 days × 4.8 h) | 5,000 ÷ 30 ÷ 8 = 20.8333/h × 1.25 × 9.6 h | 250.00 |
| Sales bonus — 3 vehicles above target | approved adjustment | 300.00 |
| **Gross earnings** | | **6,550.00** |
| Salary advance ADV-2026-0002 (1/6) | 3,000 over 6 instalments | 500.00 |
| Unpaid leave (1 day) | 5,000 ÷ 30 | 166.67 |
| **Total deductions** | | **666.67** |
| **Net salary** | 6,550.00 − 666.67 | **5,883.33** |

(The brief's example quotes net ≈ 5,884; the exact figure, rounded once per line, is
5,883.33.) The seed produces exactly these figures through the real services, and
`tests/payroll.test.ts` asserts them.

---

## 4. Lifecycle

```
DRAFT ──calculate──▶ CALCULATED ──review──▶ REVIEWED ──approve──▶ APPROVED ──mark paid──▶ PAID
  │                    ▲   │                   │                      │
  │                    └───┘ recalculate       │                      └─ reopen (ADMIN, reason) ─▶ CALCULATED
  └──────────────── cancel (reason) ◀──────────┘
```

| Step | Who | What happens |
|---|---|---|
| Create | HR / ADMIN | One period per company per month (`@@unique`); pay date defaults to the company payroll day |
| Calculate / recalculate | HR / ADMIN | `gatherPayroll` + `calculatePayroll` for everyone employed in the month, in one transaction. Records are **upserted by (period, employee)**, so a record keeps its id across recalculations; items are rebuilt. Skipped employees and warnings (negative net, missing salary, foreign currency) are returned to the screen. Audited as `CALCULATE` |
| Review | HR / ADMIN | A deliberate checkpoint; audited as `REVIEW` |
| Approve | HR / ADMIN — **not the person who calculated** when `payrollRequiresSeparateApprover` is on (default) | 1. Refused if any net is negative. 2. **Re-gathers and re-calculates everything and compares** net, gross, deductions and the exact set of source lines per employee with what was reviewed — any difference refuses approval ("recalculate first"). 3. In one transaction: links every overtime entry, adjustment and instalment to its payroll line (each link must succeed exactly once), renders and stores a PDF payslip per employee, locks the month. 4. Notifies each employee. Audited as `APPROVE` |
| Mark paid | HR / ADMIN | Payment date and reference (e.g. the WPS batch). Final. Audited as `MARK_PAID` |
| Reopen | **ADMIN only**, reason required, `APPROVED` only | Undoes approval in one transaction: sources unlinked, instalments owed again, payslip documents withdrawn; back to `CALCULATED`. A `PAID` payroll is never reopened — corrections go into the next month as adjustments. Audited as `REOPEN` |
| Cancel | HR / ADMIN, before approval | The month can be started again later |

### The month lock

While a period is `APPROVED` or `PAID`, `assertPayrollPeriodOpen`
([`services/payroll-lock.ts`](../Employee%20Management%20Platform%20BackEnd/src/services/payroll-lock.ts))
refuses check-ins, attendance corrections, overtime decisions, adjustments and advance
changes dated inside it, with a message naming the payroll. An administrator must reopen
the payroll first — which is itself audited.

---

## 5. Payslips

- Generated **once, at approval**, from the stored snapshot, as a PDF (pdfkit): company,
  employee, period, every earning and deduction line with quantity and rate, totals, net,
  working/absent/late/overtime figures.
- Stored as an employee `Document` (category `PAYSLIP`) with the bytes in `DocumentFile`
  (plus SHA-256 checksum). `GET /payslips/:id/pdf` serves **those bytes** — a payslip is
  never re-rendered from live data.
- Visible to the employee and HR only; the manager is refused. Served with
  `Cache-Control: private, no-store`. A payslip document cannot be deleted from the
  documents page. HR opening a register or someone else's payslip is audited
  (`VIEW_SENSITIVE`).
- The on-screen payslip (My pay → click a month) renders from the same snapshot, so it
  matches the PDF line for line.

---

## 6. Salary advances

```
PENDING ──approve (amount, instalments, first month)──▶ APPROVED ──mark paid out──▶ PAID
   │                                                      │                          │ first instalment deducted
   ├─ reject (reason) ─▶ REJECTED                          └─ cancel ─▶ CANCELLED     ▼
   └─ withdraw / cancel ─▶ CANCELLED                                               ACTIVE ──last instalment──▶ COMPLETED
```

- The employee requests an amount and a number of months; HR decides the final amount,
  instalments and first deduction month. Policy limits (`maxAdvanceAmount`,
  `maxAdvanceInstallments`, `allowConcurrentAdvances`) are checked on request; at
  approval the amount can only go down and the instalments must stay within the limit.
  The requester can never decide their own advance, and a line manager never sees one.
- The split is exact: `splitEvenly` divides in decimals and puts any remainder cent on
  the last instalment — 1,000 over 3 is 333.33 + 333.33 + 333.34.
- Instalments are deducted only by an approved payroll (they become `DEDUCTED` and link
  to the payroll line); reopening that payroll makes them `SCHEDULED` again.
- HR can reschedule what remains (reason required); deducted instalments never change.
- Example (seeded): **3,000 AED over 6 months = 500 a month**. The August payroll
  deducted the first instalment, so ADV-2026-0002 is `ACTIVE` with 2,500 remaining; the
  last deduction makes it `COMPLETED`.

## 7. Bonuses and deductions (adjustments)

`PayrollAdjustment` rows — `BONUS`, `COMMISSION`, `ALLOWANCE`, `OVERTIME`, `DEDUCTION`,
`ABSENCE`, `UNPAID_LEAVE`, `ADVANCE`, `OTHER` — each with a kind (earning or deduction),
an amount, a payroll month and a status (`PENDING → APPROVED/REJECTED`, `CANCELLED`).
Only approved, unlinked adjustments reach payroll; with four-eyes on, whoever entered one
cannot approve it. They are relational rows, not JSON blobs, so reports and audits can
query them.

## 8. Overtime

Created automatically from attendance (minutes past the scheduled end, early arrival if
the policy counts it, all worked minutes on a rest day or holiday) above
`minOvertimeMinutes`, or entered manually by HR. With `overtimeRequiresApproval` (default)
an entry is paid only once HR or the direct manager approves it; the manager sees
minutes, never amounts. The multiplier is frozen on the entry when it is created.

---

## 9. Tested

| Suite | Covers |
|---|---|
| `tests/payroll-engine.test.ts` | the pure calculation: proration per basis, segments, rates, rounding, negative net |
| `tests/payroll.test.ts` (39 tests) | the full lifecycle against Postgres: the seeded example to the cent, four-eyes, approval refusing changed data, source linking, no double payment, reopen, month lock, payslip PDF bytes and access, advances and adjustments |
| `e2e/tests/payroll.spec.js` | HR recalculates and reviews, HR's approval is refused, the administrator approves and marks paid, the employee opens and downloads the PDF, a colleague and the manager are refused |
| `e2e/tests/advances.spec.js` | request → approve with plan → mark paid → exact instalments visible to the employee |
