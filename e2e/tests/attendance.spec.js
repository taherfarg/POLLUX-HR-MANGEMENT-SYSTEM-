import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, trackPageHealth } from '../helpers.js'

/**
 * Employee attendance, end to end: check in and out from the browser, with the
 * server's clock and the employee's own timezone deciding every figure.
 *
 * Amine works remotely from Algiers. The seed never writes his attendance for
 * the current day, so the flow is the same whatever time the suite runs.
 */
test.describe('Employee attendance', () => {
  test('a remote employee checks in and out and sees the day in their own timezone', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.amine)

    const card = page.getByRole('region', { name: "Today's attendance" })
    await expect(card).toContainText('Africa/Algiers')
    await expect(card.getByRole('button', { name: 'Check in' })).toBeVisible()

    await card.getByRole('button', { name: 'Check in' }).click()
    await expect(page.locator('.toast')).toContainText(/Checked in at \d{2}:\d{2} \(Africa\/Algiers\)/)
    await expect(card).toContainText(/Checked in at \d{2}:\d{2}/)

    // The server keeps one record per day - a second check-in is refused.
    const again = await apiAs(page, '/attendance/check-in', { method: 'POST', body: {} })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/already checked in/i)

    await card.getByRole('button', { name: 'Check out' }).click()
    await expect(page.locator('.toast')).toContainText(/Checked out at \d{2}:\d{2}/)
    await expect(card).toContainText(/Done for today at \d{2}:\d{2}/)

    const today = await apiAs(page, '/attendance/today')
    expect(today.status).toBe(200)
    expect(today.body.data.timezone).toBe('Africa/Algiers')
    expect(today.body.data.today.checkIn).toBeTruthy()
    expect(today.body.data.today.checkOut).toBeTruthy()
    expect(today.body.data.canCheckIn).toBe(false)
    expect(today.body.data.canCheckOut).toBe(false)

    // The history now holds the day that was just recorded.
    await gotoPage(page, 'My attendance')
    await expect(page.getByRole('grid', { name: 'Attendance calendar' })).toBeVisible()
    const history = await apiAs(page, '/me/attendance')
    const recorded = history.body.data.days.find((day) => day.date === today.body.data.localDate)
    expect(recorded?.isVirtual).toBe(false)
    expect(recorded?.checkOut).toBeTruthy()
    health.assertClean()
  })

  test('an employee cannot list, board or correct attendance', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    const mine = await apiAs(page, '/me/attendance')
    expect(mine.status).toBe(200)

    // The list is scoped to the caller; the company board and corrections are
    // HR's, refused at the API whatever the UI shows.
    const listed = await apiAs(page, '/attendance?pageSize=100')
    expect(listed.status).toBe(200)
    expect(new Set(listed.body.data.map((row) => row.employee.fullName))).toEqual(new Set(['Ahmed Nabil']))
    expect((await apiAs(page, '/attendance/board')).status).toBe(403)
    const stored = mine.body.data.days.find((day) => !day.isVirtual)
    expect(stored, 'the seed gives Ahmed a month of attendance').toBeTruthy()
    const patch = await apiAs(page, `/attendance/${stored.id}`, { method: 'PATCH', body: { status: 'PRESENT', reason: 'Trying my luck' } })
    expect(patch.status).toBe(403)
  })

  test('HR sees the company board and a correction needs a reason', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Attendance')
    await expect(page.getByText('Amine Benali').first()).toBeVisible()

    const board = await apiAs(page, '/attendance/board')
    expect(board.status).toBe(200)
    // Everyone is evaluated in their own timezone.
    const nour = board.body.data.rows.find((row) => row.employee.fullName === 'Nour El-Sayed')
    expect(nour.timezone).toBe('Africa/Cairo')

    const records = await apiAs(page, '/attendance?pageSize=5')
    const stored = records.body.data.find((row) => !row.isVirtual)
    expect(stored, 'the seed holds a month of attendance').toBeTruthy()
    const noReason = await apiAs(page, `/attendance/${stored.id}`, { method: 'PATCH', body: { status: 'PRESENT' } })
    expect(noReason.status).toBe(422)
    health.assertClean()
  })
})
