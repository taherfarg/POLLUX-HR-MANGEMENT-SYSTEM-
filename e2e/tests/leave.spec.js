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

  test('HR records leave that has already started, for someone else, and approves it at once', async ({ page }) => {
    const health = trackPageHealth(page)
    // Monday to Wednesday of the week before last: leave that has already
    // happened. In early January that week belongs to last year's balance,
    // so the window moves six weeks on instead.
    const start = new Date()
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 14)
    if (start.getUTCFullYear() !== new Date().getUTCFullYear()) start.setUTCDate(start.getUTCDate() + 42)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 2)
    const iso = (date) => date.toISOString().slice(0, 10)

    await signIn(page, ACCOUNTS.hr)
    // Rashid, the PRO officer, has no login and nothing else in this suite
    // touches his leave.
    const rashid = (await apiAs(page, '/employees?q=Rashid')).body.data[0]
    const annualBefore = (await apiAs(page, `/employees/${rashid.id}/leave-balances`)).body.data.find((row) => row.leaveType.code === 'ANNUAL')

    await gotoPage(page, 'Requests')
    await page.getByRole('button', { name: 'Record leave' }).click()
    const dialog = page.getByRole('dialog', { name: 'Record leave' })
    await dialog.getByRole('combobox', { name: /^Employee/ }).selectOption({ label: `${rashid.fullName} (${rashid.employeeNumber})` })
    await expect(dialog.getByLabel('Leave type')).toHaveValue(/.+/)
    await dialog.getByLabel('Start date').fill(iso(start))
    await dialog.getByLabel('End date').fill(iso(end))
    // His own count, from his own schedule and calendar.
    await expect(dialog).toContainText(/This request uses \d+(\.\d+)? working day/)
    const days = Number((await dialog.locator('.leave-balance-inline p b').innerText()).trim())
    await dialog.getByLabel('Reason').fill('Annual leave agreed before it was recorded')
    await expect(dialog.getByRole('checkbox', { name: /Approve it now/ })).toBeChecked()
    await dialog.getByRole('button', { name: 'Record and approve' }).click()
    await expect(page.locator('.toast')).toContainText(new RegExp(`LV-\\d{4}-\\d{4} approved — ${days} day\\(s\\) of leave for ${rashid.fullName}`))

    const annualAfter = (await apiAs(page, `/employees/${rashid.id}/leave-balances`)).body.data.find((row) => row.leaveType.code === 'ANNUAL')
    expect(annualAfter.usedDays).toBe(annualBefore.usedDays + days)
    expect(annualAfter.pendingDays).toBe(annualBefore.pendingDays)
    health.assertClean()
  })

  test('HR cancels leave that was approved by mistake, from the employee file, and the days go back', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    const rashid = (await apiAs(page, '/employees?q=Rashid')).body.data[0]
    // Recorded with the wrong dates and approved at once.
    const { startDate, endDate, year } = leaveWindow(1)
    const annual = async () =>
      (await apiAs(page, `/employees/${rashid.id}/leave-balances?year=${year}`)).body.data.find((row) => row.leaveType.code === 'ANNUAL')
    const before = await annual()

    const recorded = await apiAs(page, '/requests/leave', {
      method: 'POST',
      body: { employeeId: rashid.id, leaveTypeId: before.leaveType.id, startDate, endDate, reason: 'Recorded by HR' },
    })
    expect(recorded.status).toBe(201)
    const { reference } = recorded.body.data
    const days = recorded.body.data.leave.workingDays
    expect((await apiAs(page, `/requests/${recorded.body.data.id}/approve`, { method: 'POST', body: {} })).status).toBe(200)
    expect((await annual()).usedDays).toBe(before.usedDays + days)

    // His file, Leave tab: the request opens from its row.
    await gotoPage(page, 'Employees')
    await page.getByRole('textbox', { name: /Search/ }).fill('Rashid')
    await page.locator('tr', { hasText: rashid.fullName }).click()
    await page.getByRole('tablist', { name: 'Profile sections' }).getByRole('tab', { name: /^Leave/ }).click()
    const startLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${startDate}T12:00:00`))
    await page.locator('tr', { hasText: `${startLabel} –` }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: reference })
    await expect(dialog).toContainText('Approved')

    await dialog.getByRole('button', { name: 'Cancel leave' }).click()
    await dialog.getByRole('button', { name: 'Cancel leave' }).click()
    await expect(dialog).toContainText('Add a short reason')
    await dialog.getByRole('textbox', { name: /Reason/ }).fill('Recorded with the wrong dates')
    await dialog.getByRole('button', { name: 'Cancel leave' }).click()
    await expect(page.locator('.toast')).toContainText(new RegExp(`${reference} cancelled\\. ${days} days? returned to the balance`))
    await expect(dialog).toContainText('Cancelled')
    await expect(dialog).toContainText('Recorded with the wrong dates')
    await expect(dialog.getByRole('button', { name: 'Cancel leave' })).toHaveCount(0)

    const after = await annual()
    expect(after.usedDays).toBe(before.usedDays)
    expect(after.pendingDays).toBe(before.pendingDays)
    health.assertClean()
  })
})
