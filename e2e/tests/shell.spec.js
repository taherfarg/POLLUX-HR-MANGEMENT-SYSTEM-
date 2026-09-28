import { test, expect } from '@playwright/test'
import { ACCOUNTS, signIn, trackPageHealth } from '../helpers.js'

/**
 * The frame around every page: search that opens any page or person from the
 * keyboard, and an appearance the person chooses and keeps.
 */
test.describe('App shell', () => {
  test('search opens a page or a person, from the keyboard or the top bar', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)

    await page.keyboard.press('Control+k')
    const search = page.getByRole('dialog', { name: 'Search' })
    await expect(search).toBeVisible()
    await search.getByRole('combobox').fill('leave bal')
    await expect(search.getByRole('option', { name: /Leave balances/ })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(search).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Leave balances')

    // People, by name, straight to their file.
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await search.getByRole('combobox').fill('Ahmed')
    await search.getByRole('option', { name: /Ahmed Nabil/ }).click()
    await expect(page.getByRole('tablist', { name: 'Profile sections' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ahmed Nabil', exact: true })).toBeVisible()

    // Escape closes it without going anywhere.
    await page.keyboard.press('Control+k')
    await expect(search).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(search).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Ahmed Nabil', exact: true })).toBeVisible()
    health.assertClean()
  })

  test('the appearance switch turns the app dark, and a reload keeps it', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.employee)
    const root = page.locator('html')
    // The browser reports a light device, which "match the device" follows.
    await expect(root).toHaveAttribute('data-theme', 'light')

    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(root).toHaveAttribute('data-theme', 'dark')

    await page.getByRole('button', { name: 'Match the device' }).click()
    await expect(root).toHaveAttribute('data-theme', 'light')
    health.assertClean()
  })
})
