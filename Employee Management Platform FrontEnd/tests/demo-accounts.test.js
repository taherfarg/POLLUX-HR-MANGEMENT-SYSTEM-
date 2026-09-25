import { describe, expect, it } from 'vitest'
import { demoAccountsEnabled } from '../src/data.js'

describe('one-click demo logins on the sign-in page', () => {
  it('are offered in development, where the demo is seeded', () => {
    expect(demoAccountsEnabled({ DEV: true })).toBe(true)
  })

  it('are left out of a production build unless it asks for them', () => {
    expect(demoAccountsEnabled({ DEV: false })).toBe(false)
    expect(demoAccountsEnabled({ DEV: false, VITE_DEMO_ACCOUNTS: 'false' })).toBe(false)
    expect(demoAccountsEnabled({ DEV: false, VITE_DEMO_ACCOUNTS: 'true' })).toBe(true)
  })
})
