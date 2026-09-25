import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end acceptance suite for Pollux HR.
 *
 * These tests drive the real frontend against the real API against a real
 * PostgreSQL database. Nothing is mocked - that is the point: the unit and
 * integration suites already prove the pieces, and this proves they are wired
 * together.
 *
 * The API is booted against its own `pollux_e2e` database (migrated and seeded by
 * `prepare-db.mjs`) so a run can never damage the demo data a reviewer is
 * looking at.
 *
 * Environment:
 *   E2E_DATABASE_URL                 database for the run (default: local docker on 5433)
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE   a preinstalled Chromium, instead of `playwright install`
 */
const API_PORT = 4100
const WEB_PORT = 5273
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://ems:ems_local_password@localhost:5433/pollux_e2e?schema=public'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined

export default defineConfig({
  testDir: './tests',
  // The suite shares one database, so tests run one at a time rather than
  // racing each other over the same balances and payroll month.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { executablePath },
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
      testIgnore: /(responsive|payroll)\.spec\.js/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, launchOptions: { executablePath } },
      testMatch: /responsive\.spec\.js/,
    },
    {
      // Approving the month's payroll locks its attendance, so the payroll
      // flow runs once everything that checks in or changes this month is done.
      name: 'payroll',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
      testMatch: /payroll\.spec\.js/,
      dependencies: ['desktop', 'mobile'],
    },
  ],

  webServer: [
    {
      command: 'npm run dev',
      cwd: '../Employee Management Platform BackEnd',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        // Test-only secrets, never used anywhere else.
        JWT_ACCESS_SECRET: 'e2e_only_access_secret_0123456789abcdefghij',
        JWT_REFRESH_SECRET: 'e2e_only_refresh_secret_9876543210zyxwvutsrq',
        SEED_DEMO_PASSWORD: 'Passw0rd!23',
        LOG_LEVEL: 'silent',
        // The suite signs in dozens of times from one address; production
        // keeps the strict default.
        RATE_LIMIT_AUTH_MAX: '1000',
        RATE_LIMIT_API_MAX: '5000',
        // Forced empty so the suite never makes a live AI call: E2E must be
        // deterministic, offline and free.
        GOOGLE_API_KEY: '',
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
      cwd: '../Employee Management Platform FrontEnd',
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
})
