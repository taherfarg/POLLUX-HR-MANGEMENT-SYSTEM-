import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, leaveWindow, myBalance, signIn, signOut, trackPageHealth } from '../helpers.js'

/**
 * Leave, end to end across roles: the employee asks, the balance holds the
 * days as pending, the manager decides, and the balance settles. Every number
 * asserted comes from the API, never from the test's own arithmetic about
 * working days: the server decides what a date range costs.
 */

async function requestLeave(page, { startDate, endDate, reason }) {
  await gotoPage(page, 'My requests')
  await page.getByRole('button', { name: 'Request leave' }).click()
  const dialog = page.getByRole('dialog', { name: 'Request time away' })
  await expect(dialog.getByLabel('Leave type')).toHaveValue(/.+/)
  await dialog.getByLabel('Start date').fill(startDate)
  await dialog.getByLabel('End date').fill(endDate)
  // The preview is the API's count of chargeable days for this person.
  await expect(dialog).toContainText(/This request uses \d+(\.\d+)? working day/)
  const days = Number((await dialog.locator('.leave-balance-inline p b').innerText()).trim())
  await dialog.getByLabel('Reason').fill(reason)
  await dialog.getByRole('button', { name: 'Submit request' }).click()
  await expect(page.locator('.toast')).toContainText(/LV-\d{4}-\d{4} submitted/)
  const reference = (await page.locator('.toast').innerText()).match(/LV-\d{4}-\d{4}/)[0]
  return { reference, days }
}

async function decide(page, reference, decision, note) {
  await gotoPage(page, 'Approvals')
  await page.locator('tr', { hasText: reference }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(reference)
  if (note) await dialog.getByRole('textbox').fill(note)
  await dialog.getByRole('button', { name: decision }).click()
  await expect(page.locator('.toast')).toContainText(`${reference} ${decision === 'Approve' ? 'approved' : 'rejected'}`)
  await expect(dialog).toContainText(decision === 'Approve' ? 'Approved' : 'Rejected')
  await dialog.getByRole('button', { name: 'Close' }).click()
}

test.describe('Leave requests', () => {
  test('employee requests leave, the manager approves, the balance moves from pending to used', async ({ page }) => {
    const health = trackPageHealth(page)
    const window = leaveWindow(0)

    await signIn(page, ACCOUNTS.employee)
    const before = await myBalance(page, 'ANNUAL', window.year)
    const { reference, days } = await requestLeave(page, { ...window, reason: 'Family visit in Alexandria' })
    expect(days).toBeGreaterThan(0)

    const held = await myBalance(page, 'ANNUAL', window.year)
    expect(held.pending).toBe(before.pending + days)
    expect(held.available).toBe(before.available - days)
    await expect(page.locator('tr', { hasText: reference })).toContainText('Pending')
    await signOut(page)

    await signIn(page, ACCOUNTS.manager)
    await decide(page, reference, 'Approve', 'Enjoy the trip - Daniel covers your accounts.')
    await signOut(page)

    await signIn(page, ACCOUNTS.employee)
    const after = await myBalance(page, 'ANNUAL', window.year)
    expect(after.pending).toBe(before.pending)
    expect(after.used).toBe(before.used + days)
    expect(after.available).toBe(before.available - days)
    await gotoPage(page, 'My requests')
    await expect(page.locator('tr', { hasText: reference })).toContainText('Approved')
    health.assertClean()
  })

  test('a rejection needs a reason, which the employee sees, and releases the held days', async ({ page }) => {
    const window = leaveWindow(2)

    await signIn(page, ACCOUNTS.employee)
    const before = await myBalance(page, 'ANNUAL', window.year)
    const { reference } = await requestLeave(page, { ...window, reason: 'Long weekend' })
    await signOut(page)

    await signIn(page, ACCOUNTS.manager)
    // Without a reason the dialog refuses to reject.
    await gotoPage(page, 'Approvals')
    await page.locator('tr', { hasText: reference }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click()
    await expect(page.getByRole('dialog')).toContainText('Add a short reason')
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await decide(page, reference, 'Reject', 'Quarter-end: the showroom needs full cover that week.')
    await signOut(page)

    await signIn(page, ACCOUNTS.employee)
    const after = await myBalance(page, 'ANNUAL', window.year)
    expect(after.pending).toBe(before.pending)
    expect(after.available).toBe(before.available)
    await gotoPage(page, 'My requests')
    await page.locator('tr', { hasText: reference }).click()
    await expect(page.getByRole('dialog')).toContainText('Quarter-end: the showroom needs full cover that week.')
  })

  test('a manager decides only their own team, never their own request', async ({ page }) => {
    await signIn(page, ACCOUNTS.manager)
    const inbox = await apiAs(page, '/requests?myTeamOnly=true&pageSize=100')
    expect(inbox.status).toBe(200)
    const reports = await apiAs(page, '/me/team')
    const teamIds = new Set(reports.body.data.map((person) => person.id))
    for (const request of inbox.body.data) expect(teamIds.has(request.employee.id)).toBe(true)

    // Someone outside the team - Nour reports to the General Manager.
    await signOut(page)
    await signIn(page, ACCOUNTS.nour)
    const { startDate, endDate } = leaveWindow(4)
    const annual = (await apiAs(page, '/leave/types')).body.data.find((type) => type.code === 'ANNUAL')
    const created = await apiAs(page, '/requests/leave', {
      method: 'POST',
      body: { leaveTypeId: annual.id, startDate, endDate, reason: 'Cairo family event' },
    })
    expect(created.status).toBe(201)
    await signOut(page)

    await signIn(page, ACCOUNTS.manager)
    const refused = await apiAs(page, `/requests/${created.body.data.id}/approve`, { method: 'POST', body: {} })
    expect([403, 404]).toContain(refused.status)
  })
})
