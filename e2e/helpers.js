import { expect } from '@playwright/test'

export const DEMO_PASSWORD = 'Passw0rd!23'

/** The seeded Pollux Motors logins (see prisma/seed.ts). */
export const ACCOUNTS = {
  admin: 'admin@pollux.demo', // Khalid Al Mansoori - General Manager, ADMIN
  hr: 'hr@pollux.demo', // Sara Haddad - HR Manager, HR_ADMIN
  manager: 'manager@pollux.demo', // Youssef Karim - Sales Manager, MANAGER of Ahmed, Layla, Daniel
  employee: 'employee@pollux.demo', // Ahmed Nabil - Sales Executive, EMPLOYEE
  layla: 'layla.mansour@pollux.demo', // field sales, reports to Youssef
  nour: 'nour.elsayed@pollux.demo', // remote in Cairo, Egyptian holiday calendar, no advances
  amine: 'amine.benali@pollux.demo', // remote in Algiers, never checked in on the seeded "today"
}

/** Signs in through the real login form and waits for the workspace to render. */
export async function signIn(page, email, password = DEMO_PASSWORD) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Work email' }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeAttached()
}

export async function signOut(page) {
  await openNavIfCollapsed(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
}

/** On a phone the sidebar is behind a menu button; on desktop it is always open. */
export async function openNavIfCollapsed(page) {
  const burger = page.getByRole('button', { name: 'Open navigation' })
  if (await burger.isVisible().catch(() => false)) {
    await burger.click()
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Opens a page from the sidebar by its exact label ("My pay", "Team"...). The
 * label may carry a count badge ("Requests 4").
 */
export async function gotoPage(page, label) {
  await openNavIfCollapsed(page)
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}( \\d+)?$`) })
    .click()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(label)
}

/**
 * Calls the API with the token the app stored, so a test can assert on
 * persisted state (or probe an endpoint the UI never offers) with exactly the
 * signed-in user's own credentials.
 */
export async function apiAs(page, path, options = {}) {
  return page.evaluate(
    async ([p, opts]) => {
      const token = localStorage.getItem('ems.accessToken')
      const res = await fetch(`/api/v1${p}`, {
        method: opts.method || 'GET',
        headers: {
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        /* no JSON body */
      }
      return { status: res.status, body: json }
    },
    [path, options],
  )
}

/** Fetches a file endpoint as the signed-in user: status, type and the first bytes. */
export async function fileAs(page, path) {
  return page.evaluate(async (p) => {
    const token = localStorage.getItem('ems.accessToken')
    const res = await fetch(`/api/v1${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const bytes = new Uint8Array(await res.arrayBuffer())
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      size: bytes.length,
      head: String.fromCharCode(...bytes.slice(0, 8)),
    }
  }, path)
}

/**
 * Fails the test if the page threw, logged an application error, or an API
 * call failed with a 5xx.
 *
 * Two kinds of browser log are not application errors and are ignored: web
 * fonts that could not load (that depends on the network the suite runs on),
 * and the browser's own "Failed to load resource ... 4xx" line, which it
 * prints for every refused request - including the refusals a test provokes on
 * purpose to prove a rule. A 5xx is still caught, by the response listener.
 */
export function trackPageHealth(page) {
  const consoleErrors = []
  const failedRequests = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const url = msg.location()?.url ?? ''
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return
    if (/Failed to load resource/.test(msg.text()) && (!url.includes('/api/') || /status of 4\d\d/.test(msg.text()))) return
    consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`))
  page.on('response', (res) => {
    if (res.status() >= 500 && res.url().includes('/api/')) failedRequests.push(`${res.status()} ${res.url()}`)
  })
  return {
    assertClean() {
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
      expect(failedRequests, `5xx responses: ${failedRequests.join(' | ')}`).toEqual([])
    },
  }
}

const pad = (value) => String(value).padStart(2, '0')
const dateKey = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

/** Today in Dubai, the company timezone the seed is written against. */
export function dubaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${parts}T00:00:00Z`)
}

/**
 * A Monday-Tuesday leave window reserved for one test, `weeksOut` weeks after
 * the first Monday at least six weeks away. The seeded requests all sit within
 * the next four weeks, and each test uses its own offset, so the overlap guard
 * never trips between tests. The chargeable days come from the API preview,
 * never from this helper: a public holiday inside the window is not charged.
 */
export function leaveWindow(weeksOut) {
  const start = dubaiToday()
  start.setUTCDate(start.getUTCDate() + 42 + weeksOut * 7)
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  // Leave may not span two calendar years (balances are per year).
  if (end.getUTCFullYear() !== start.getUTCFullYear()) {
    start.setUTCDate(start.getUTCDate() + 7)
    end.setUTCDate(end.getUTCDate() + 7)
  }
  return { startDate: dateKey(start), endDate: dateKey(end), year: start.getUTCFullYear() }
}

/** An employee's own balance for one leave type code, in the given year. */
export async function myBalance(page, code, year) {
  const res = await apiAs(page, `/me/leave-balances?year=${year}`)
  const balance = res.body.data.find((row) => row.leaveType.code === code)
  return balance
    ? { used: Number(balance.usedDays), pending: Number(balance.pendingDays), available: Number(balance.availableDays) }
    : { used: 0, pending: 0, available: 0 }
}
