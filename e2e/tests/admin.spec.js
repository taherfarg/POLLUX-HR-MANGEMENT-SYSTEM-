import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, signOut, trackPageHealth } from '../helpers.js'

/**
 * HR and administration from the browser: the employee file with its pay
 * tabs, leave balances, reports and exports, company policy with its audit
 * trail, and user logins.
 */
test.describe('HR and administration', () => {
  test('HR opens an employee file with every section, pay included', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Employees')
    await page.getByRole('textbox', { name: /Search/ }).fill('Ahmed')
    await page.locator('tr', { hasText: 'Ahmed Nabil' }).click()

    const tabs = page.getByRole('tablist', { name: 'Profile sections' })
    for (const name of ['Overview', 'Personal', 'Employment', 'Attendance', 'Leave', 'Salary', 'Advances', 'Payroll', 'Documents', 'Timeline']) {
      await expect(tabs.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible()
    }
    await tabs.getByRole('tab', { name: /^Salary/ }).click()
    await expect(page.getByText('AED 5,000.00').first()).toBeVisible()
    await tabs.getByRole('tab', { name: /^Advances/ }).click()
    await expect(page.getByText(/ADV-\d{4}-\d{4}/).first()).toBeVisible()
    health.assertClean()
  })

  test('leave balances read entitlement + carried - used - pending = available', async ({ page }) => {
    await signIn(page, ACCOUNTS.hr)
    const balances = await apiAs(page, `/leave/balances?q=Ahmed&pageSize=50`)
    expect(balances.status).toBe(200)
    const annual = balances.body.data.find((row) => row.employee.fullName === 'Ahmed Nabil' && row.leaveType.code === 'ANNUAL')
    const { entitledDays, carriedOverDays, usedDays, pendingDays, availableDays } = Object.fromEntries(
      ['entitledDays', 'carriedOverDays', 'usedDays', 'pendingDays', 'availableDays'].map((key) => [key, Number(annual[key])]),
    )
    expect(availableDays).toBe(entitledDays + carriedOverDays - usedDays - pendingDays)
    // The seeded example from the brief: 30 + 2 carried, 10 used.
    expect(entitledDays).toBe(30)
    expect(carriedOverDays).toBe(2)
    expect(usedDays).toBe(10)

    await gotoPage(page, 'Leave balances')
    await expect(page.locator('tr', { hasText: 'Ahmed Nabil' }).filter({ hasText: 'Annual' }).first()).toContainText(String(availableDays))
  })

  test('HR previews a report and exports it as CSV, Excel and PDF, each export audited', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Reports')
    await page.getByRole('button', { name: /Payroll report/ }).click()
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.locator('table').filter({ hasText: 'Ahmed Nabil' }).first()).toBeVisible()

    const expectations = { CSV: /\.csv$/, Excel: /\.xlsx$/, PDF: /\.pdf$/ }
    for (const [label, pattern] of Object.entries(expectations)) {
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: label, exact: true }).click()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/^pollux-payroll-report-/)
      expect(file.suggestedFilename()).toMatch(pattern)
      const bytes = await readFile(await file.path())
      if (label === 'CSV') {
        const text = bytes.toString('utf8')
        expect(text.charCodeAt(0)).toBe(0xfeff) // BOM, so Excel reads Arabic names correctly
        expect(text).toContain('Ahmed Nabil')
      }
      if (label === 'Excel') expect(bytes.subarray(0, 2).toString()).toBe('PK')
      if (label === 'PDF') expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
    }

    const exports = await apiAs(page, '/audit-logs?action=EXPORT&pageSize=10')
    expect(exports.body.data.filter((entry) => /payroll/i.test(entry.summary)).length).toBeGreaterThanOrEqual(3)
    health.assertClean()
  })

  test('the administrator changes attendance policy and the audit trail shows before and after', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.admin)
    const original = (await apiAs(page, '/settings/company')).body.data.attendance.lateGraceMinutes
    const next = original === 20 ? 25 : 20

    await gotoPage(page, 'Company settings')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Attendance' }).click()
    await page.getByLabel(/Late grace/).fill(String(next))
    await page.getByRole('button', { name: 'Save attendance' }).click()
    await expect(page.locator('.toast')).toContainText('Attendance settings saved.')

    await gotoPage(page, 'Audit logs')
    await page.getByRole('combobox', { name: 'Record type' }).selectOption('CompanySettings')
    await page.locator('tr', { hasText: 'Updated company settings (attendance)' }).first().click()
    const entry = page.getByRole('dialog')
    const change = entry.locator('tr', { hasText: 'attendance.lateGraceMinutes' })
    await expect(change).toContainText(String(original))
    await expect(change).toContainText(String(next))
    await entry.getByRole('button', { name: 'Close' }).click()

    await apiAs(page, '/settings/company', { method: 'PATCH', body: { attendance: { lateGraceMinutes: original } } })
    health.assertClean()
  })

  test('HR can read company settings but not change them', async ({ page }) => {
    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Company settings')
    await expect(page.getByText('Only an administrator can change company settings.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Save / })).toHaveCount(0)
    await expect(page.getByLabel('Legal name')).toBeDisabled()
  })

  test('the administrator creates a login; the new user must set a password first', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.admin)
    await gotoPage(page, 'Users & roles')
    await page.getByRole('button', { name: 'Create login' }).click()
    const create = page.getByRole('dialog', { name: 'Create a login' })
    const grace = await create.locator('option', { hasText: 'Grace Okafor' }).getAttribute('value')
    await create.getByRole('combobox', { name: /^Employee/ }).selectOption(grace)
    await create.getByRole('button', { name: 'Create login' }).click()

    const secret = page.getByRole('dialog', { name: 'Temporary password' })
    await expect(secret).toBeVisible()
    const temporary = (await secret.locator('.secret-box span').innerText()).trim()
    expect(temporary.length).toBeGreaterThanOrEqual(12)
    const email = (await secret.locator('.eyebrow').innerText()).trim()
    await secret.getByRole('button', { name: 'Done' }).click()
    await expect(page.locator('tr', { hasText: email })).toContainText('Temporary password')
    health.assertClean()
    await signOut(page)

    // First sign-in: the password change cannot be skipped.
    await signIn(page, email, temporary)
    const forced = page.getByRole('dialog', { name: 'Set a new password' })
    await expect(forced).toBeVisible()
    await expect(forced.getByRole('button', { name: 'Close' })).toHaveCount(0)
    await forced.getByLabel('Current password').fill(temporary)
    await forced.getByLabel('New password', { exact: true }).fill('Pollux2026Secure')
    await forced.getByLabel('Confirm new password').fill('Pollux2026Secure')
    await forced.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByRole('dialog', { name: 'Password updated' })).toBeVisible()
  })
})
