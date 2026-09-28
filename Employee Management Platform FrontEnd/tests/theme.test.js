import { describe, expect, it } from 'vitest'
import { readThemePreference, resolveTheme, THEME_KEY } from '../src/hooks/useTheme.jsx'

const storage = (values) => ({ getItem: (key) => values[key] ?? null })

describe('appearance', () => {
  it('reads the stored choice, and falls back to the device setting', () => {
    expect(readThemePreference(storage({ [THEME_KEY]: 'dark' }))).toBe('dark')
    expect(readThemePreference(storage({ [THEME_KEY]: 'light' }))).toBe('light')
    expect(readThemePreference(storage({}))).toBe('system')
    expect(readThemePreference(storage({ [THEME_KEY]: 'sepia' }))).toBe('system')
  })

  it('treats blocked storage, as in a private window, as no choice', () => {
    const blocked = {
      getItem() {
        throw new Error('SecurityError')
      },
    }
    expect(readThemePreference(blocked)).toBe('system')
    expect(readThemePreference(undefined)).toBe('system')
  })

  it('follows the device only when the choice is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
