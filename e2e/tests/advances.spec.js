import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, signOut, trackPageHealth } from '../helpers.js'

/**
 * Salary advances, end to end: the employee asks, HR approves a repayment plan
 * and records the payout, and the employee sees exactly what will come off
 * each payslip. The split is the server's, in exact decimals.
 */
test.describe('Salary advances', () => {
  test('employee requests an advance, HR approves and pays it, the plan is visible to the employee', async ({ page }) => {
    const health = trackPageHealth(page)

    await signIn(page, ACCOUNTS.nour)
    await gotoPage(page, 'My pay')
    await page.getByRole('button', { name: 'Request a salary advance' }).click()
    const form = page.getByRole('dialog', { name: 'Request a salary advance' })
    await form.getByLabel('Amount (AED)').fill('1500')
    await form.getByLabel('Repay over (months)').fill('3')
    await form.getByLabel('Reason').fill('Laptop repair for remote work')
    await form.getByRole('button', { name: 'Submit request' }).click()
    await expect(page.locator('.toast')).toContainText(/ADV-\d{4}-\d{4} submitted/)
    const reference = (await page.locator('.toast').innerText()).match(/ADV-\d{4}-\d{4}/)[0]
    await expect(page.locator('tr', { hasText: reference })).toContainText('Pending')

    // Company policy is enforced by the API: the seeded limit is AED 10,000.
    const tooMuch = await apiAs(page, '/advances', { method: 'POST', body: { amount: 20000, requestedInstallments: 6, reason: 'Testing the limit' } })
    expect(tooMuch.status).toBeGreaterThanOrEqual(400)
    expect(tooMuch.status).toBeLessThan(500)
    await signOut(page)

    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Salary advances')
    await page.locator('tr', { hasText: reference }).click()
    const detail = page.getByRole('dialog', { name: `Salary advance ${reference}` })
    await detail.getByRole('button', { name: 'Approve' }).click()
    const approve = page.getByRole('dialog', { name: `Approve ${reference}` })
    await expect(approve.getByLabel('Approved amount (AED)')).toHaveValue('1500')
    await approve.getByLabel('Instalments').fill('3')
    await approve.getByRole('button', { name: 'Approve' }).click()
    await expect(page.locator('.toast')).toContainText(`${reference} approved`)

    await detail.getByRole('button', { name: 'Mark as paid out' }).click()
    const paid = page.getByRole('dialog', { name: 'Mark as paid out' })
    await paid.getByLabel('Payment reference').fill('TRF-E2E-001')
    await paid.getByRole('button', { name: 'Mark as paid' }).click()
    await expect(page.locator('.toast')).toContainText(`${reference} marked as paid out`)
    await expect(detail.locator('tbody tr')).toHaveCount(3)
    await detail.getByRole('button', { name: 'Close' }).first().click()
    await signOut(page)

    await signIn(page, ACCOUNTS.nour)
    const mine = await apiAs(page, '/advances')
    const advance = mine.body.data.find((row) => row.reference === reference)
    expect(advance.status).toBe('PAID')
    const full = await apiAs(page, `/advances/${advance.id}`)
    expect(full.body.data.installments.map((row) => Number(row.amount))).toEqual([500, 500, 500])
    expect(Number(full.body.data.remainingAmount)).toBe(1500)

    await gotoPage(page, 'My pay')
    await page.getByRole('tab', { name: /Salary advances/ }).click()
    await expect(page.locator('tr', { hasText: reference })).toContainText('Paid')
    health.assertClean()
  })

  test('the requester cannot decide their own advance and managers never see pay', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    const own = await apiAs(page, '/advances')
    expect(own.status).toBe(200)
    const ahmedAdvance = own.body.data[0]
    expect(ahmedAdvance, 'Ahmed has a seeded advance').toBeTruthy()
    for (const action of ['approve', 'reject', 'mark-paid']) {
      const res = await apiAs(page, `/advances/${ahmedAdvance.id}/${action}`, { method: 'POST', body: { approvedAmount: 1, numberOfInstallments: 1, repaymentStartMonth: '2030-01', note: 'self' } })
      expect(res.status, action).toBe(403)
    }
    await signOut(page)

    // Youssef manages Ahmed but sees only his own advances, never his team's.
    await signIn(page, ACCOUNTS.manager)
    const listed = await apiAs(page, '/advances?pageSize=100')
    expect(listed.status).toBe(200)
    const self = await apiAs(page, '/me/profile')
    for (const row of listed.body.data) expect(row.employee.id).toBe(self.body.data.id)
    const direct = await apiAs(page, `/advances/${ahmedAdvance.id}`)
    expect([403, 404]).toContain(direct.status)
  })
})
