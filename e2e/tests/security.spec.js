import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, fileAs, gotoPage, signIn, signOut } from '../helpers.js'

/**
 * Authorization and privacy, asserted at the API with each user's own token -
 * a hidden button is not a security boundary - plus the few UI guarantees
 * that matter (pages a role must not reach, tabs it must not see).
 */

const SALARY_KEYS = /"(baseSalary|housingAllowance|transportAllowance|otherAllowances|grossEarnings|netSalary|totalFixed|salary)"/

async function idOf(page, name) {
  const res = await apiAs(page, `/employees?q=${encodeURIComponent(name)}`)
  return res.body.data[0].id
}

test.describe('Authorization and privacy boundaries', () => {
  test('nothing is readable without signing in', async ({ page }) => {
    await page.goto('/')
    for (const path of ['/employees', '/payroll/periods', '/payslips', '/attendance/today', '/reports', '/audit-logs', '/settings/company']) {
      expect((await apiAs(page, path)).status, path).toBe(401)
    }
  })

  test('an employee reaches only their own pay, attendance and records', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    const layla = await idOf(page, 'Layla')

    // A colleague is an address-book entry, never a salary.
    const colleague = await apiAs(page, `/employees/${layla}`)
    expect(colleague.status).toBe(200)
    expect(JSON.stringify(colleague.body)).not.toMatch(SALARY_KEYS)
    expect(colleague.body.data.dateOfBirth).toBeUndefined()
    for (const path of [`/employees/${layla}/compensation`, `/employees/${layla}/documents`, `/employees/${layla}/timeline`]) {
      expect((await apiAs(page, path)).status, path).toBeGreaterThanOrEqual(403)
    }

    // HR and payroll surfaces are closed.
    for (const path of ['/payroll/periods', '/payroll/adjustments', '/attendance/board', '/reports', '/reports/payroll', '/reports/attendance', '/audit-logs', '/users']) {
      const res = await apiAs(page, path)
      expect([403, 404], path).toContain(res.status)
    }
    expect((await apiAs(page, '/settings/company', { method: 'PATCH', body: { attendance: { lateGraceMinutes: 120 } } })).status).toBe(403)

    // Only their own payslips come back, whatever the filter says.
    const self = await apiAs(page, '/me/profile')
    const slips = await apiAs(page, `/payslips?employeeId=${layla}`)
    for (const slip of slips.body.data) expect(slip.employee.id).toBe(self.body.data.id)

    // Company settings: the public subset only - no payroll or advance policy.
    const settings = await apiAs(page, '/settings/company')
    expect(settings.status).toBe(200)
    expect(settings.body.data.advances).toBeUndefined()
    expect(settings.body.data.attendance).toBeUndefined()

    // The UI does not offer management pages, and a typed URL falls back home.
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await expect(nav.getByRole('button', { name: /^Payroll runs/ })).toHaveCount(0)
    await page.goto('/#/payroll')
    await expect(page.getByRole('region', { name: "Today's attendance" })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Payroll runs/ })).toHaveCount(0)
  })

  test('a manager sees the team but never salary, payroll or payslips', async ({ page }) => {
    await signIn(page, ACCOUNTS.manager)
    const ahmed = await idOf(page, 'Ahmed')

    const report = await apiAs(page, `/employees/${ahmed}`)
    expect(report.status).toBe(200)
    expect(JSON.stringify(report.body)).not.toMatch(SALARY_KEYS)
    expect((await apiAs(page, `/employees/${ahmed}/compensation`)).status).toBe(403)

    for (const path of ['/payroll/periods', '/payroll/adjustments', '/reports/payroll', '/reports/advances', '/dashboard/compensation-overview', '/audit-logs', '/users']) {
      const res = await apiAs(page, path)
      expect([403, 404], path).toContain(res.status)
    }

    // Payslips: their own only.
    const self = await apiAs(page, '/me/profile')
    const slips = await apiAs(page, `/payslips?employeeId=${ahmed}`)
    for (const slip of slips.body.data) expect(slip.employee.id).toBe(self.body.data.id)

    // The dashboard and the report catalogue carry no pay data.
    const dashboard = await apiAs(page, '/dashboard')
    expect(dashboard.body.data.payroll).toBeUndefined()
    const team = JSON.stringify(dashboard.body.data.team ?? {})
    expect(team).not.toMatch(SALARY_KEYS)
    const catalog = await apiAs(page, '/reports')
    const types = catalog.body.data.map((entry) => entry.type)
    expect(types).not.toContain('payroll')
    expect(types).not.toContain('advances')

    // In the UI a report's profile has no pay tabs.
    await gotoPage(page, 'Team')
    await page.locator('tr', { hasText: 'Ahmed Nabil' }).click()
    const tabs = page.getByRole('tablist', { name: 'Profile sections' })
    await expect(tabs.getByRole('tab', { name: 'Attendance' })).toBeVisible()
    for (const name of ['Salary', 'Advances', 'Payroll']) await expect(tabs.getByRole('tab', { name })).toHaveCount(0)
  })

  test('HR runs HR but company settings belong to the administrator', async ({ page }) => {
    await signIn(page, ACCOUNTS.hr)
    const ahmed = await idOf(page, 'Ahmed')
    expect((await apiAs(page, `/employees/${ahmed}/compensation`)).status).toBe(200)
    expect((await apiAs(page, '/audit-logs')).status).toBe(200)

    // HR reads the full policy but may not change it.
    const settings = await apiAs(page, '/settings/company')
    expect(settings.body.data.payroll.salaryDayBasis).toBeTruthy()
    expect((await apiAs(page, '/settings/company', { method: 'PATCH', body: { attendance: { lateGraceMinutes: 120 } } })).status).toBe(403)

    // HR cannot mint administrators.
    const eligible = await apiAs(page, '/users/eligible-employees')
    if (eligible.body.data.length > 0) {
      const res = await apiAs(page, '/users', { method: 'POST', body: { employeeId: eligible.body.data[0].id, role: 'ADMIN' } })
      expect(res.status).toBe(403)
    }
    await signOut(page)

    await signIn(page, ACCOUNTS.admin)
    const update = await apiAs(page, '/settings/company', { method: 'PATCH', body: { attendance: { lateGraceMinutes: 10 } } })
    expect(update.status).toBe(200)
    expect(update.body.data.attendance.lateGraceMinutes).toBe(10)
    const trail = await apiAs(page, '/audit-logs?entityType=CompanySettings')
    expect(trail.body.data[0].summary).toContain('attendance')
    // Put the policy back for the suites that follow.
    await apiAs(page, '/settings/company', { method: 'PATCH', body: { attendance: { lateGraceMinutes: settings.body.data.attendance.lateGraceMinutes } } })
  })

  test('a payslip PDF is only served to its owner and to HR', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    const slips = await apiAs(page, '/payslips')
    const slip = slips.body.data.find((entry) => entry.hasPayslip)
    expect(slip, 'the seed issues last month’s payslips').toBeTruthy()
    expect((await fileAs(page, `/payslips/${slip.id}/pdf`)).status).toBe(200)
    await signOut(page)

    await signIn(page, ACCOUNTS.layla)
    expect([403, 404]).toContain((await fileAs(page, `/payslips/${slip.id}/pdf`)).status)
    await signOut(page)

    await signIn(page, ACCOUNTS.hr)
    const asHr = await fileAs(page, `/payslips/${slip.id}/pdf`)
    expect(asHr.status).toBe(200)
    expect(asHr.head.startsWith('%PDF')).toBe(true)
  })
})
