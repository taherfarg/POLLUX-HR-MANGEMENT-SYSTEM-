import { createContext, useContext, useEffect, useMemo, useState } from 'react'

/**
 * Light, dark, or whatever the device uses. The choice is kept per browser;
 * index.html applies it before the first paint, so a dark-mode reload never
 * flashes white.
 */

export const THEME_KEY = 'pollux.theme'
export const THEME_CHOICES = ['system', 'light', 'dark']

const DARK_QUERY = '(prefers-color-scheme: dark)'
const THEME_COLOURS = { light: '#f4f5f7', dark: '#0b0d11' }

/** The stored choice, or 'system' when there is none (or storage is blocked). */
export function readThemePreference(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(THEME_KEY)
    return THEME_CHOICES.includes(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

/** What a choice looks like right now: 'light' or 'dark'. */
export function resolveTheme(preference, systemPrefersDark) {
  if (preference === 'light' || preference === 'dark') return preference
  return systemPrefersDark ? 'dark' : 'light'
}

const systemPrefersDark = () => Boolean(window.matchMedia?.(DARK_QUERY).matches)

function applyTheme(preference) {
  const theme = resolveTheme(preference, systemPrefersDark())
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOURS[theme])
}

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(() => readThemePreference())

  useEffect(() => {
    applyTheme(preference)
    try {
      localStorage.setItem(THEME_KEY, preference)
    } catch {
      // A private window may refuse storage; the choice then lasts this visit.
    }
    if (preference !== 'system' || !window.matchMedia) return undefined
    const media = window.matchMedia(DARK_QUERY)
    const follow = () => applyTheme('system')
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [preference])

  const value = useMemo(() => ({ preference, setPreference }), [preference])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider')
  return context
}
