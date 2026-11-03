import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, trackPageHealth } from '../helpers.js'

/**
 * The HR assistant's place in the app. The suite runs without a Google key,
 * so this covers who gets the assistant, how a question reaches it, and what
 * people see before it is switched on; the answering itself is covered by the
 * backend suite with a scripted model.
 */
test.describe('Assistant', () => {
  test('HR reaches it from the menu and from search, and is told when it is not switched on', async ({ page }) => {
    const health = trackPageHealth(page)
    await signIn(page, ACCOUNTS.hr)
    await gotoPage(page, 'Assistant')

    await expect(page.getByRole('heading', { name: 'The assistant is not switched on yet' })).toBeVisible()
    await expect(page.getByLabel('Your question')).toBeDisabled()

    // A question typed into search goes to the assistant.
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').fill('who was late yesterday')
    await page.getByRole('option', { name: 'Ask: “who was late yesterday”' }).click()
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Assistant')

    // The dashboard's daily brief goes there too.
    await gotoPage(page, 'Dashboard')
    await page.getByRole('button', { name: 'Daily brief' }).click()
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Assistant')

    health.assertClean()
    // Asked anyway, the API says why it cannot answer (a 503 the page never makes).
    const ask = await apiAs(page, '/assistant/ask', { method: 'POST', body: { messages: [{ role: 'user', text: 'Who is on leave today?' }] } })
    expect(ask.status).toBe(503)
    expect(ask.body.error.code).toBe('ASSISTANT_UNAVAILABLE')
  })

  test('a manager has it for their team; an employee does not have it at all', async ({ page }) => {
    await signIn(page, ACCOUNTS.manager)
    await gotoPage(page, 'Assistant')
    await expect(page.getByText('Ask about your team’s attendance, leave, approvals and tasks')).toBeVisible()
    expect((await apiAs(page, '/assistant/status')).body.data).toEqual({ enabled: false, scope: 'team' })

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await signIn(page, ACCOUNTS.employee)
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Assistant' })).toHaveCount(0)
    expect((await apiAs(page, '/assistant/status')).status).toBe(403)
    const ask = await apiAs(page, '/assistant/ask', { method: 'POST', body: { messages: [{ role: 'user', text: 'Show me everyone’s attendance' }] } })
    expect(ask.status).toBe(403)
  })
})
