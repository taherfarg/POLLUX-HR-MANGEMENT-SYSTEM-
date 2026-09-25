import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Migrates and seeds the dedicated `pollux_e2e` database.
 *
 * This runs as a `pretest` step rather than as a Playwright `globalSetup`
 * because the API refuses to start when its database is unreachable (a
 * deliberate fail-fast in server.ts). The schema therefore has to exist before
 * Playwright launches the `webServer` processes, and a pretest script is the
 * only place that ordering is guaranteed.
 *
 * The schema comes from the real migration history (`migrate deploy`, the path
 * production takes), so a broken migration fails here first; Prisma creates
 * the database on the first run. Nothing is ever dropped. The seed then
 * rebuilds the demo data, so every run starts from the documented dataset and
 * one run's approvals never change what the next run asserts.
 *
 * Because the seed replaces data, it only ever runs against a database whose
 * name ends in `_e2e`. (A database left by the pre-Pollux suite, built with
 * `db push`, has no migration history - use the new default name, or drop the
 * old one yourself.)
 */
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://ems:ems_local_password@localhost:5433/pollux_e2e?schema=public'

const databaseName = new URL(E2E_DATABASE_URL).pathname.replace(/^\//, '')
if (!/_e2e$/.test(databaseName)) {
  console.error(`[e2e] refusing to seed "${databaseName}": the acceptance database name must end in _e2e.`)
  process.exit(1)
}

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../Employee Management Platform BackEnd')
// The seed runs attendance, advances and payroll through the application's own
// services, which validate the full API environment - so it gets the same
// e2e-only secrets the API process is started with in playwright.config.js.
const env = {
  ...process.env,
  DATABASE_URL: E2E_DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'e2e_only_access_secret_0123456789abcdefghij',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'e2e_only_refresh_secret_9876543210zyxwvutsrq',
  SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD ?? 'Passw0rd!23',
  LOG_LEVEL: 'silent',
}

console.log(`[e2e] preparing the acceptance database "${databaseName}"…`)
execSync('npx prisma migrate deploy', { cwd: backend, env, stdio: 'inherit' })
execSync('npm run db:seed', { cwd: backend, env, stdio: 'inherit' })
console.log('[e2e] acceptance database ready.')
