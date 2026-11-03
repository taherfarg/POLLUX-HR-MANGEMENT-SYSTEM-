import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AUTH_EXPIRED_EVENT, tokenStore } from '../api/client.js'
import { forgetConversations } from '../lib/assistant.js'
import * as apiEndpoints from '../api/endpoints.js'

const AuthContext = createContext(null)

/**
 * Owns the session for the whole app.
 *
 * On mount it tries to restore a session from the stored token by calling
 * /auth/me rather than trusting a cached profile, so a role change or a
 * deactivated account is reflected immediately instead of after the token
 * expires. While that call is in flight the app shows a boot screen, which
 * avoids a flash of the login page for an already-signed-in user.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [bootstrapping, setBootstrapping] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function restore() {
      if (!tokenStore.access) {
        setBootstrapping(false)
        return
      }
      try {
        const profile = await apiEndpoints.fetchProfile()
        if (!cancelled) setSession(profile)
      } catch {
        tokenStore.clear()
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    }

    restore()
    return () => {
      cancelled = true
    }
  }, [])

  // The client dispatches this when a refresh fails, so any screen can lose its
  // session cleanly without each one handling 401 itself.
  useEffect(() => {
    const handleExpiry = () => setSession(null)
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpiry)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpiry)
  }, [])

  const signIn = useCallback(async (email, password) => {
    const profile = await apiEndpoints.login(email, password)
    setSession(profile)
    return profile
  }, [])

  const signOut = useCallback(async () => {
    await apiEndpoints.logout()
    forgetConversations()
    setSession(null)
  }, [])

  const value = useMemo(
    () => ({ session, bootstrapping, signIn, signOut }),
    [session, bootstrapping, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
