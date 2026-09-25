import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, fileAs, gotoPage, signIn, signOut, trackPageHealth } from '../helpers.js'

/**
 * Monthly payroll, end to end, and the employee's payslip.
 *
 * The seed leaves the current month CALCULATED. HR recalculates (the other
 * suites have changed attendance since) and reviews; HR may not approve what
 * HR calculated (four-eyes), so the administrator approves and marks it paid;
 * the employee then reads and downloads the stored PDF payslip.
 *
 * Approving locks the month's attendance, so this suite runs after the others
 * (see the `payroll` project in playwright.config.js).
 */
test.describe('Payroll and payslips', () => {
  test('HR prepares, a second person approves, the employee gets the payslip', async ({ page }) => {
    const health = trackPageHealth(page)

    await signIn(page, ACCOUNTS.hr)
    const periods = await apiAs(page, '/payroll/periods')
    const open = periods.body.data.find((period) => period.status === 'CALCULATED')
    expect(open, 'the seed leaves the current month calculated').toBeTruthy()

    await gotoPage(page, 'Payroll runs')
    await page.locator('tr', { hasText: open.name }).click()
    await expect(page.getByRole('heading', { name: `Payroll · ${open.name}` })).toBeVisible()

    await page.getByRole('button', { name: 'Recalculate' }).click()
    await expect(page.locator('.toast')).toContainText(/Calculated \d+ payslip/)
    await page.getByRole('button', { name: 'Mark reviewed' }).click()
    await expect(page.locator('.toast')).toContainText('Marked as reviewed.')

    // Four-eyes: whoever calculated cannot approve.
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    const confirmHr = page.getByRole('dialog', { name: `Approve payroll for ${open.name}` })
    await confirmHr.getByRole('button', { name: 'Approve payroll' }).click()
    await expect(confirmHr).toContainText('cannot also approve')
    await confirmHr.getByRole('button', { name: 'Cancel' }).click()
    await signOut(page)

    await signIn(page, ACCOUNTS.admin)
    await gotoPage(page, 'Payroll runs')
    await page.locator('tr', { hasText: open.name }).click()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByRole('dialog', { name: `Approve payroll for ${open.name}` }).getByRole('button', { name: 'Approve payroll' }).click()
    await expect(page.locator('.toast')).toContainText(`Payroll for ${open.name} approved`)
    await expect(page.getByText('Locked.')).toBeVisible()

    await page.getByRole('button', { name: 'Mark as paid' }).click()
    const paid = page.getByRole('dialog', { name: 'Mark payroll as paid' })
    await paid.getByLabel('Payment reference').fill('WPS-E2E-0001')
    await paid.getByRole('button', { name: 'Mark as paid' }).click()
    await expect(page.locator('.toast')).toContainText(`Payroll for ${open.name} marked as paid`)

    // Locked means locked: attendance in the month can no longer be changed.
    const lockedPeriod = await apiAs(page, `/payroll/periods/${open.id}`)
    expect(lockedPeriod.body.data.status).toBe('PAID')
    expect(lockedPeriod.body.data.isLocked).toBe(true)
    await signOut(page)

    // The employee sees the payslip and downloads the stored PDF.
    await signIn(page, ACCOUNTS.employee)
    await gotoPage(page, 'My pay')
    const row = page.locator('tr', { hasText: open.name })
    await expect(row).toContainText('Paid')
    const payslips = await apiAs(page, '/payslips')
    const slip = payslips.body.data.find((entry) => entry.period.id === open.id)
    expect(slip, 'a payslip for the approved month').toBeTruthy()

    const popup = page.waitForEvent('popup')
    await row.getByRole('button', { name: 'PDF' }).click()
    await expect((await popup)).toHaveURL(/^blob:/)

    const pdf = await fileAs(page, `/payslips/${slip.id}/pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.contentType).toContain('application/pdf')
    expect(pdf.head.startsWith('%PDF')).toBe(true)
    expect(pdf.size).toBeGreaterThan(1000)

    // The on-screen payslip matches the stored figures.
    await row.locator('td').first().click()
    const view = page.getByRole('dialog')
    await expect(view.locator('.net-band')).toContainText('Net salary')
    const net = Number(slip.netSalary).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    await expect(view.locator('.net-band')).toContainText(net)
    await view.getByRole('button', { name: 'Close' }).click()
    await signOut(page)

    // Nobody else can read it - not a colleague, not the employee's manager.
    for (const account of [ACCOUNTS.layla, ACCOUNTS.manager]) {
      await signIn(page, account)
      const foreign = await fileAs(page, `/payslips/${slip.id}/pdf`)
      expect([403, 404], account).toContain(foreign.status)
      await signOut(page)
    }
    health.assertClean()
  })
})
