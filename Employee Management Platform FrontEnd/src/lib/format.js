/** Shared formatters. Kept in one place so dates, time and money read identically everywhere. */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A calendar date from the API ("2026-08-30") is a day, not an instant: it is
 * parsed as local midnight so it never shifts to the day before in a timezone
 * west of UTC.
 */
function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'string' && DATE_KEY.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  return new Date(value)
}

export const formatDate = (value, options = {}) => {
  if (!value) return '—'
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...options,
  }).format(date)
}

/** "Mon, 14 Sep" for day lists. */
export const formatDay = (value) => formatDate(value, { weekday: 'short', year: undefined })

export const formatTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Date and time of an instant, e.g. for audit entries. */
export const formatDateTime = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

/** "2026-09" -> "September 2026". */
export const formatMonth = (monthKey) => {
  if (!monthKey) return '—'
  const [year, month] = String(monthKey).split('-').map(Number)
  if (!year || !month) return '—'
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1))
}

/**
 * Whole-number money for headline figures (salary cards). Currency always
 * comes from the record, never a global default.
 */
export const formatMoney = (value, currency) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  if (!currency) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value))
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value))
}

/**
 * Exact money for payroll: two decimals, grouped, with the currency code in
 * front ("AED 5,883.33"). The amount was already rounded by the server; this
 * only formats it.
 */
export const formatAmount = (value, currency) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  const text = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(Number(value)))
  return `${currency ? `${currency} ` : ''}${Number(value) < 0 ? '-' : ''}${text}`
}

export const formatDays = (value) => {
  const days = Number(value ?? 0)
  const rounded = Number.isInteger(days) ? days : days.toFixed(1)
  return `${rounded} day${days === 1 ? '' : 's'}`
}

/** 95 -> "1h 35m", 30 -> "30m", 0 -> "0m". */
export const formatMinutes = (value) => {
  const minutes = Math.round(Number(value ?? 0))
  if (!minutes) return '0m'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const rest = Math.abs(minutes) % 60
  const sign = minutes < 0 ? '-' : ''
  if (!hours) return `${sign}${rest}m`
  return `${sign}${hours}h${rest ? ` ${rest}m` : ''}`
}

/** Minutes as decimal hours, "7.50". */
export const formatHours = (minutes) => (Number(minutes ?? 0) / 60).toFixed(2)

/**
 * Counted noun with the right ending: `plural(1, 'entity', 'entities')` gives
 * "1 entity". Irregular plurals take the third argument; regular ones just get
 * an "s". Half days count as plural ("0.5 working days"), which is how people
 * say it.
 */
export const plural = (count, singular, pluralForm) => {
  const n = Number(count ?? 0)
  const shown = Number.isInteger(n) ? n : n.toFixed(1)
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`)
  return `${shown} ${word}`
}

/** Coarse relative time for activity feeds - precision is not the point there. */
export const relativeTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.round(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`

  return formatDate(value, { year: undefined })
}

const pad = (value) => String(value).padStart(2, '0')

/** A local date as YYYY-MM-DD. */
export const toDateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** Today as YYYY-MM-DD in the browser's timezone, for date input defaults. */
export const todayIso = () => toDateKey(new Date())

/** This month as YYYY-MM. */
export const currentMonthKey = () => todayIso().slice(0, 7)

/** First and last day of a YYYY-MM month. */
export const monthBounds = (monthKey) => {
  const [year, month] = monthKey.split('-').map(Number)
  const last = new Date(year, month, 0).getDate()
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad(last)}` }
}

/** YYYY-MM shifted by n months. */
export const shiftMonthKey = (monthKey, delta) => {
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(year, month - 1 + delta, 1)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}
