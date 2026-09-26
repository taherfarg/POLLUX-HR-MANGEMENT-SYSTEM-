import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, signOut, trackPageHealth } from '../helpers.js'

/**
 * On-site check-in by QR code. HR sets a location to require it - a code, the
 * office position, the office network - and assigns someone there; that person
 * then checks in only by opening the QR link, on site. The browser's position
 * is set by the test; the network is the local machine's, registered by HR.
 */

const OFFICE = { latitude: 25.204849, longitude: 55.270782 }
const CODE = 'e2e-scan-me'

test.describe('On-site check-in', () => {
  test('HR sets up a QR location; the employee checks in only on site, with the code', async ({ page }) => {
    const health = trackPageHealth(page)
    const context = page.context()
    await context.grantPermissions(['geolocation'])

    // --- HR: the location and who works there ------------------------------------
    await signIn(page, ACCOUNTS.hr)
    const network = await apiAs(page, '/work-locations/my-network')
    expect(network.status).toBe(200)
    expect(network.body.data.entry, 'the address the API sees this browser at').toBeTruthy()

    const location = await apiAs(page, '/work-locations', {
      method: 'POST',
      body: {
        code: 'E2E-QR',
        name: 'QR Test Office',
        kind: 'OFFICE',
        timezone: 'Asia/Dubai',
        qrCheckInRequired: true,
        qrCode: CODE,
        ...OFFICE,
        geofenceRadiusMeters: 200,
        allowedNetworks: [network.body.data.entry],
        wifiName: 'Office-5G or Office-2G',
      },
    })
    expect(location.status).toBe(201)

    // Omar, the service advisor, has not checked in today in the seed.
    const omar = (await apiAs(page, '/employees?q=Omar')).body.data[0]
    const moved = await apiAs(page, `/employees/${omar.id}`, { method: 'PATCH', body: { workLocationId: location.body.data.id } })
    expect(moved.status).toBe(200)
    const login = await apiAs(page, '/users', { method: 'POST', body: { employeeId: omar.id, role: 'EMPLOYEE', temporaryPassword: 'Welcome2026Omar' } })
    expect(login.status).toBe(201)

    // The printable code is there for HR.
    await gotoPage(page, 'Work locations')
    await page.getByRole('button', { name: 'QR code for QR Test Office' }).click()
    const sheet = page.getByRole('dialog', { name: 'Check-in QR code' })
    await expect(sheet.getByRole('img', { name: 'QR code for QR Test Office' })).toBeVisible()
    await expect(sheet).toContainText(`#/check-in/${CODE}`)
    await sheet.getByRole('button', { name: 'Done' }).click()
    await signOut(page)

    // --- Omar: first sign-in, then home says to scan ------------------------------
    await signIn(page, login.body.data.user.email, 'Welcome2026Omar')
    const forced = page.getByRole('dialog', { name: 'Set a new password' })
    await forced.getByLabel('Current password').fill('Welcome2026Omar')
    await forced.getByLabel('New password', { exact: true }).fill('OmarPollux2026')
    await forced.getByLabel('Confirm new password').fill('OmarPollux2026')
    await forced.getByRole('button', { name: 'Change password' }).click()
    await page.getByRole('dialog', { name: 'Password updated' }).getByRole('button', { name: 'Return to sign in' }).click()
    // Signing out is done when the form is back. Reloading before that can keep
    // the old token, which is still valid, and the session comes back.
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await signIn(page, login.body.data.user.email, 'OmarPollux2026')

    const card = page.getByRole('region', { name: "Today's attendance" })
    await expect(card).toContainText('Scan the QR code at QR Test Office to check in')
    await expect(card.getByRole('button', { name: 'Check in' })).toHaveCount(0)
    const plain = await apiAs(page, '/attendance/check-in', { method: 'POST', body: {} })
    expect(plain.status).toBe(403)

    // --- Scanning from 2 km away: refused -----------------------------------------
    await context.setGeolocation({ latitude: OFFICE.latitude + 0.02, longitude: OFFICE.longitude, accuracy: 15 })
    await page.goto(`/#/check-in/${CODE}`)
    await expect(page.getByText(/Location found/)).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('alert')).toContainText('about 2.2 km from QR Test Office')

    // --- On site, with a wrong code: refused ----------------------------------------
    await context.setGeolocation({ latitude: OFFICE.latitude + 0.0004, longitude: OFFICE.longitude, accuracy: 15 })
    await page.goto('/#/check-in/not-the-code')
    await expect(page.getByText(/Location found/)).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('alert')).toContainText('Scan the QR code at QR Test Office')

    // --- On site, with the code: checked in, and the evidence kept ----------------
    await page.goto(`/#/check-in/${CODE}`)
    await expect(page.getByText(/Location found/)).toBeVisible()
    await page.getByRole('button', { name: 'Check in' }).click()
    await expect(page.getByRole('status')).toContainText('Checked in at')
    const today = await apiAs(page, '/attendance/today')
    expect(today.body.data.today.verification.checkIn).toMatchObject({ method: 'QR', locationName: 'QR Test Office', network: 'OFFICE' })
    expect(today.body.data.today.verification.checkIn.distanceMeters).toBeLessThanOrEqual(60)

    // Scanning again later - a fresh page load - offers the check-out.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Check out' })).toBeVisible()
    await signOut(page)
    health.assertClean()
  })
})
