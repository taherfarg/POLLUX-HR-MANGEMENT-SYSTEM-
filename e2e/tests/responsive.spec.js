import { test, expect } from '@playwright/test'
import { ACCOUNTS, gotoPage, signIn, trackPageHealth } from '../helpers.js'

/**
 * Runs in the `mobile` project at 390x844. People check in from their phones
 * and HR approves on the move, so the assertion that matters is that nothing
 * overflows the viewport horizontally and the navigation stays reachable.
 */
async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
      .slice(0, 5)
      .map((el) => `${el.tagName}.${(el.className || '').toString().split(' ')[0]}`),
  }))
  expect(
    overflow.scrollW,
    `${label} overflows horizontally (${overflow.scrollW} > ${overflow.clientW}); offenders: ${overflow.offenders.join(', ')}`,
  ).toBeLessThanOrEqual(overflow.clientW + 1)
}

test.describe('Mobile layout', () => {
  test('employee pages fit the phone and check-in is one tap away', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.employee)

    // The sidebar sits behind a labelled menu button at this width.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    await expect(page.getByRole('region', { name: "Today's attendance" })).toBeVisible()
    await expectNoHorizontalOverflow(page, 'employee home')

    for (const label of ['My attendance', 'My requests', 'My pay', 'My documents', 'My profile']) {
      await gotoPage(page, label)
      await expectNoHorizontalOverflow(page, `employee ${label}`)
    }
    health.assertClean()
  })

  test('HR pages fit the phone, tables become cards', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    await expectNoHorizontalOverflow(page, 'dashboard')

    for (const label of ['Employees', 'Attendance', 'Requests', 'Leave balances', 'Payroll runs', 'Salary advances', 'Reports', 'Audit logs']) {
      await gotoPage(page, label)
      await expectNoHorizontalOverflow(page, `HR ${label}`)
    }
    // Column headers are hidden; each cell labels itself.
    await expect(page.locator('.data-table.responsive thead').first()).toBeHidden()
    health.assertClean()
  })

  test('a request form opens full width and can always be closed', async ({ page }) => {
    await signIn(page, ACCOUNTS.employee)
    await gotoPage(page, 'My requests')
    await page.getByRole('button', { name: 'Request leave' }).click()

    const dialog = page.getByRole('dialog', { name: 'Request time away' })
    await expect(dialog).toBeVisible()
    await expectNoHorizontalOverflow(page, 'leave form')
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  })
})
