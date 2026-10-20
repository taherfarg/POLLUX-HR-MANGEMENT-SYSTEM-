import { test, expect } from '@playwright/test'
import { ACCOUNTS, apiAs, gotoPage, signIn, trackPageHealth } from '../helpers.js'

/**
 * Tasks and chat, between two people signed in at the same time in separate
 * browsers: what one does reaches the other without a reload.
 */

const inDays = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test.describe('Tasks', () => {
  test('a manager gives a task, the employee is notified, finishes it and comments', async ({ browser }) => {
    const title = `Call back the Al Ain fleet lead ${Date.now()}`

    const managerContext = await browser.newContext()
    const manager = await managerContext.newPage()
    const managerHealth = trackPageHealth(manager)
    await signIn(manager, ACCOUNTS.manager)
    await gotoPage(manager, 'Tasks')
    await manager.getByRole('button', { name: 'New task' }).first().click()

    const form = manager.getByRole('dialog', { name: 'New task' })
    await form.getByLabel('Task', { exact: true }).fill(title)
    await form.getByLabel('Details').fill('They asked for a quote on six pickups.')
    await form.getByRole('combobox', { name: /^For/ }).selectOption({ label: 'Ahmed Nabil · Sales Executive' })
    await form.getByLabel('Priority').selectOption('HIGH')
    await form.getByLabel('Due').fill(inDays(2))
    await form.getByRole('button', { name: 'Create task' }).click()
    await expect(manager.getByText('Task given to Ahmed Nabil. They have been notified.')).toBeVisible()

    await manager.getByRole('tab', { name: 'Assigned by me' }).click()
    await expect(manager.getByRole('row', { name: new RegExp(title) })).toBeVisible()

    // Ahmed hears about it in the notifications and opens it from there.
    const employeeContext = await browser.newContext()
    const employee = await employeeContext.newPage()
    const employeeHealth = trackPageHealth(employee)
    await signIn(employee, ACCOUNTS.employee)
    await employee.getByRole('button', { name: 'Notifications' }).click()
    await employee.getByRole('region', { name: 'Notifications' }).getByText(`New task: ${title}`).click()

    const detail = employee.getByRole('dialog', { name: title })
    await expect(detail).toBeVisible()
    await expect(detail.getByText('They asked for a quote on six pickups.')).toBeVisible()
    // The assignee moves it along but cannot rewrite what was asked.
    await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0)

    await detail.getByRole('group', { name: 'Task status' }).getByRole('button', { name: 'Done' }).click()
    await expect(employee.getByText('Task done.')).toBeVisible()
    await detail.getByLabel('Add a comment').fill('Called them - quote sent this morning.')
    await detail.getByRole('button', { name: 'Post comment' }).click()
    await expect(detail.getByText('Called them - quote sent this morning.')).toBeVisible()

    // Youssef sees it done, with the comment, and was told so.
    await manager.reload()
    await manager.getByRole('tab', { name: 'Assigned by me' }).click()
    await manager.getByRole('combobox', { name: 'Status' }).selectOption('DONE')
    await manager.getByRole('row', { name: new RegExp(title) }).click()
    const managerDetail = manager.getByRole('dialog', { name: title })
    await expect(managerDetail.getByText('Called them - quote sent this morning.')).toBeVisible()
    const notices = await apiAs(manager, '/notifications')
    expect(notices.body.data.map((notice) => notice.title)).toContain(`Task done: ${title}`)

    managerHealth.assertClean()
    employeeHealth.assertClean()
    await managerContext.close()
    await employeeContext.close()
  })
})

test.describe('Chat', () => {
  test('two colleagues message each other, and an unsent message disappears for both', async ({ browser }) => {
    const hello = `Can you cover the showroom floor at 1? ${Date.now()}`

    const ahmedContext = await browser.newContext()
    const ahmed = await ahmedContext.newPage()
    const ahmedHealth = trackPageHealth(ahmed)
    await signIn(ahmed, ACCOUNTS.employee)
    await gotoPage(ahmed, 'Chat')
    await ahmed.getByRole('button', { name: 'New', exact: true }).click()
    const picker = ahmed.getByRole('dialog', { name: 'New conversation' })
    await picker.getByRole('textbox', { name: 'Search colleagues' }).fill('Layla')
    await picker.getByRole('button', { name: /Layla Mansour/ }).click()

    await expect(ahmed.getByRole('heading', { name: 'Layla Mansour' })).toBeVisible()
    await ahmed.getByLabel('Message', { exact: true }).fill(hello)
    await ahmed.getByLabel('Message', { exact: true }).press('Enter')
    await expect(ahmed.locator('.chat-messages').getByText(hello)).toBeVisible()

    // Layla sees the unread badge, opens the chat and replies.
    const laylaContext = await browser.newContext()
    const layla = await laylaContext.newPage()
    const laylaHealth = trackPageHealth(layla)
    await signIn(layla, ACCOUNTS.layla)
    await expect(layla.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: /^Chat \d+$/ })).toBeVisible()
    await gotoPage(layla, 'Chat')
    await layla.getByRole('button', { name: /Ahmed Nabil/ }).click()
    await expect(layla.locator('.chat-messages').getByText(hello)).toBeVisible()
    await layla.getByLabel('Message', { exact: true }).fill('Yes - I will be there from 1 to 2.')
    await layla.getByRole('button', { name: 'Send message' }).click()

    // It reaches Ahmed's open conversation without a reload.
    await expect(ahmed.locator('.chat-messages').getByText('Yes - I will be there from 1 to 2.')).toBeVisible()

    // Ahmed unsends his first message; Layla's copy goes too.
    await ahmed.locator('.msg', { hasText: hello }).getByRole('button', { name: 'Delete message' }).click()
    await ahmed.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete' }).click()
    await expect(ahmed.locator('.chat-messages').getByText(hello)).toHaveCount(0)
    await expect(layla.locator('.chat-messages').getByText(hello)).toHaveCount(0)
    await expect(layla.locator('.chat-messages').getByText('Message deleted')).toBeVisible()

    // Nobody outside the conversation can read it - HR included.
    const conversationId = new URL(ahmed.url()).hash.split('/')[2]
    const hrContext = await browser.newContext()
    const hr = await hrContext.newPage()
    await signIn(hr, ACCOUNTS.hr)
    expect((await apiAs(hr, `/chat/conversations/${conversationId}/messages`)).status).toBe(404)

    ahmedHealth.assertClean()
    laylaHealth.assertClean()
    await ahmedContext.close()
    await laylaContext.close()
    await hrContext.close()
  })
})
