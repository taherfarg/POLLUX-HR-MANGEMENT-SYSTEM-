/**
 * HTTP client for the Employee Management Platform API.
 *
 * Everything the rest of the app needs from the network layer lives here:
 * the base URL, token storage, automatic access-token refresh, and turning the
 * API's error envelope into a typed error the UI can render.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1'

const ACCESS_TOKEN_KEY = 'ems.accessToken'
const REFRESH_TOKEN_KEY = 'ems.refreshToken'

/**
 * Mirrors the API's error envelope: { error: { code, message, details, requestId } }.
 * `details` is the per-field map from a 422, which forms render inline.
 */
export class ApiError extends Error {
  constructor(status, body) {
    const payload = body?.error ?? {}
    super(payload.message || 'Something went wrong. Please try again.')
    this.name = 'ApiError'
    this.status = status
    this.code = payload.code || 'UNKNOWN'
    this.details = payload.details || null
    this.requestId = payload.requestId || null
  }

  /** First message for a field, so a form can show it next to the input. */
  fieldError(field) {
    const messages = this.details?.[field]
    return Array.isArray(messages) ? messages[0] : undefined
  }

  /** Flattens every field message into one readable line for a toast. */
  get detailSummary() {
    if (!this.details) return this.message
    const messages = Object.values(this.details).flat()
    return messages.length ? messages.join(' ') : this.message
  }
}

// --- Token storage --------------------------------------------------------
// localStorage rather than sessionStorage so a page refresh or a reopened tab
// keeps the session, which the brief requires of the demo.

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_TOKEN_KEY)
  },
  get refresh() {
    return localStorage.getItem(REFRESH_TOKEN_KEY)
  },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
  },
  clear() {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
  },
}

/**
 * Broadcast when the session cannot be recovered, so the app shell can drop to
 * the login screen from anywhere without every caller handling it.
 */
export const AUTH_EXPIRED_EVENT = 'ems:auth-expired'

function notifySessionExpired() {
  tokenStore.clear()
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
}

// --- Refresh --------------------------------------------------------------

/**
 * Single-flight refresh. Several requests can fail with 401 at the same moment;
 * without this they would each try to refresh, and because the API rotates
 * refresh tokens the later attempts would present an already-used token and
 * revoke the whole session.
 */
let refreshInFlight = null

async function refreshAccessToken() {
  const refreshToken = tokenStore.refresh
  if (!refreshToken) return false

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (!response.ok) return false
        const body = await response.json()
        tokenStore.set(body.data)
        return true
      } catch {
        return false
      } finally {
        refreshInFlight = null
      }
    })()
  }

  return refreshInFlight
}

// --- Request --------------------------------------------------------------

function buildUrl(path, params) {
  const url = `${API_BASE}${path}`
  if (!params) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    // Skip empty values so `?q=` never reaches the API as a filter.
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','))
    } else {
      search.set(key, String(value))
    }
  }

  const query = search.toString()
  return query ? `${url}?${query}` : url
}

async function parseBody(response) {
  if (response.status === 204) return null
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: { code: 'BAD_RESPONSE', message: 'The server returned an unreadable response.' } }
  }
}

/**
 * Performs one API call.
 *
 * On a 401 with a refresh token available it refreshes once and retries. A
 * second failure means the session is genuinely gone, so it is cleared and the
 * app is told to return to the login screen.
 *
 * Returns the full response envelope ({ data, meta?, summary?, unreadCount? })
 * rather than just `data`, because list screens need the pagination metadata.
 */
export async function apiRequest(path, { method = 'GET', body, params, auth = true, retry = true } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const token = tokenStore.access
  if (auth && token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // fetch only rejects on a genuine network failure, so this is "API unreachable".
    throw new ApiError(0, {
      error: {
        code: 'NETWORK_ERROR',
        message: 'Cannot reach the server. Check that the API is running and try again.',
      },
    })
  }

  if (response.status === 401 && auth && retry && tokenStore.refresh) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      return apiRequest(path, { method, body, params, auth, retry: false })
    }
    notifySessionExpired()
  }

  const payload = await parseBody(response)

  if (!response.ok) {
    throw new ApiError(response.status, payload)
  }

  return payload
}

/**
 * Fetches a file (payslip PDF, report export) with the same bearer token and
 * refresh-once behaviour as JSON calls. Returns the blob and the file name the
 * server suggested.
 */
export async function apiBlob(path, { params, retry = true } = {}) {
  const headers = {}
  const token = tokenStore.access
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(buildUrl(path, params), { headers })
  } catch {
    throw new ApiError(0, {
      error: { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check that the API is running and try again.' },
    })
  }

  if (response.status === 401 && retry && tokenStore.refresh) {
    const refreshed = await refreshAccessToken()
    if (refreshed) return apiBlob(path, { params, retry: false })
    notifySessionExpired()
  }

  if (!response.ok) {
    throw new ApiError(response.status, await parseBody(response))
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  return {
    blob: await response.blob(),
    fileName: match?.[1] ?? 'download',
    contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
  }
}

/** Convenience wrapper for the common case of wanting only the payload. */
export async function apiData(path, options) {
  const response = await apiRequest(path, options)
  return response?.data
}

export const api = {
  get: (path, params) => apiRequest(path, { method: 'GET', params }),
  post: (path, body) => apiRequest(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => apiRequest(path, { method: 'PATCH', body }),
  delete: (path) => apiRequest(path, { method: 'DELETE' }),
}
