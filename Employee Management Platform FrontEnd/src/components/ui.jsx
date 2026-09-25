import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, LockKeyhole, RotateCcw, Search, X, XCircle } from 'lucide-react'
import { formatAmount } from '../lib/format.js'

/** Shared presentational primitives used across every page. */

/** The Pollux mark: a four-point star - Pollux is the brightest star in Gemini. */
export function BrandMark({ size = 'md' }) {
  const pixels = size === 'lg' ? 26 : 19
  return (
    <span className={`brand-mark ${size === 'lg' ? 'brand-mark-lg' : ''}`} aria-hidden="true">
      <svg width={pixels} height={pixels} viewBox="0 0 24 24">
        <path d="M12 1.5c.5 5.2 2.3 8 10.5 10.5-8.2 2.5-10 5.3-10.5 10.5-.5-5.2-2.3-8-10.5-10.5C9.7 9.5 11.5 6.7 12 1.5Z" fill="#f5b301" />
        <circle cx="12" cy="12" r="2.2" fill="#0b1324" />
      </svg>
    </span>
  )
}

export function Avatar({ employee, size = 'md' }) {
  // Rows can reference a person the caller may not load in full, so render a
  // neutral placeholder instead of crashing.
  if (!employee) {
    return <span className={`avatar avatar-${size}`} style={{ background: '#e2e8f0' }} aria-hidden="true">—</span>
  }
  return (
    <span className={`avatar avatar-${size}`} style={{ background: employee.color }} aria-hidden="true">
      {employee.initials}
    </span>
  )
}

/**
 * Status chip. The label is shown as given; its tone comes from the status
 * value (PENDING, APPROVED, ...), or from `tone` when a page wants a specific
 * colour.
 */
export function StatusPill({ status, label, tone, children }) {
  if (!status && !label) return null
  const key = tone ? `tone-${tone}` : `status-${String(status).toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')}`
  return (
    <span className={`status-pill ${key}`}>
      <span />
      {children || label || humanize(status)}
    </span>
  )
}

/** SCREAMING_CASE -> Sentence case, for enum values without a dedicated label. */
export function humanize(value) {
  if (value === null || value === undefined) return ''
  const text = String(value).replaceAll('_', ' ').toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function Chip({ icon: Icon, children, color }) {
  return (
    <span className="chip">
      {color && <i className="chip-dot" style={{ background: color }} />}
      {Icon && <Icon size={13} />}
      {children}
    </span>
  )
}

/** An amount from the API (already rounded server-side), shown with its currency. */
export function Money({ value, currency, negative = false }) {
  if (value === null || value === undefined) return <span className="money muted">—</span>
  return (
    <span className={`money ${negative && Number(value) !== 0 ? 'money-neg' : ''}`}>
      {negative && Number(value) !== 0 ? '−' : ''}
      {formatAmount(value, currency)}
    </span>
  )
}

export function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined
    // Errors and one-time secrets stay longer - they carry something to read.
    const timeout = window.setTimeout(onClose, toast.type === 'error' || toast.sticky ? 9000 : 3600)
    return () => window.clearTimeout(timeout)
  }, [toast, onClose])

  if (!toast) return null
  return (
    <div className={`toast toast-${toast.type || 'success'}`} role="status" aria-live="polite">
      {toast.type === 'error' ? <XCircle size={19} /> : <CheckCircle2 size={19} />}
      <span>{toast.message}</span>
      <button onClick={onClose} aria-label="Dismiss notification">
        <X size={16} />
      </button>
    </div>
  )
}

/**
 * Open dialogs, innermost last. Dialogs stack (an approval over a detail
 * view): Escape closes only the top one, and the page stays scroll-locked
 * until the last one closes.
 */
const openDialogs = []

export function Modal({ open, onClose, title, eyebrow, children, size = 'md', dismissible = true }) {
  const titleId = useId()
  // The latest handlers, read at key time: registering must happen once per
  // opening, or a re-render would move this dialog to the top of the stack.
  const latest = useRef({ onClose, dismissible })
  useEffect(() => {
    latest.current = { onClose, dismissible }
  })
  useEffect(() => {
    if (!open) return undefined
    openDialogs.push(titleId)
    const handleKey = (event) => {
      if (event.key === 'Escape' && latest.current.dismissible && openDialogs[openDialogs.length - 1] === titleId) latest.current.onClose()
    }
    document.addEventListener('keydown', handleKey)
    document.body.classList.add('modal-open')
    return () => {
      document.removeEventListener('keydown', handleKey)
      openDialogs.splice(openDialogs.indexOf(titleId), 1)
      if (openDialogs.length === 0) document.body.classList.remove('modal-open')
    }
  }, [open, titleId])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && dismissible && onClose()}>
      <section className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
          </div>
          {dismissible && (
            <button className="icon-button" onClick={onClose} aria-label="Close">
              <X size={20} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  )
}

export function FormField({ label, error, hint, children, className = '' }) {
  return (
    <label className={`field ${error ? 'field-error' : ''} ${className}`}>
      <span>
        {label}
        {error && <em>{error}</em>}
      </span>
      {children}
      {hint && !error && <small className="field-hint">{hint}</small>}
    </label>
  )
}

export function Detail({ label, value, icon: Icon }) {
  return (
    <div>
      <dt>
        {Icon && <Icon size={13} />}
        {label}
      </dt>
      <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </div>
  )
}

export function RequestFact({ icon: Icon, label, value }) {
  return (
    <div>
      <span>
        <Icon size={16} />
      </span>
      <p>{label}</p>
      <strong>{value ?? '—'}</strong>
    </div>
  )
}

export function EmptyMini({ icon: Icon, title, text }) {
  return (
    <div className="empty-mini">
      <span>
        <Icon size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon = Search, title, text, action }) {
  return (
    <div className="empty-state">
      <Icon size={26} />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  )
}

// --- Layout -----------------------------------------------------------------

export function PageHeader({ title, description, actions }) {
  return (
    <header className="page-header">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="button-row">{actions}</div>}
    </header>
  )
}

export function Panel({ title, description, actions, children, footer, className = '', bodyClassName = 'panel-body', flush = false }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="button-row">{actions}</div>}
        </header>
      )}
      {flush ? children : <div className={bodyClassName}>{children}</div>}
      {footer && <footer className="panel-footer">{footer}</footer>}
    </section>
  )
}

export function StatCard({ icon: Icon, label, value, hint, tone = 'brand', onClick }) {
  const Tag = onClick ? 'button' : 'div'
  const toneStyle = TONES[tone] ?? TONES.brand
  return (
    <Tag className="stat-card" onClick={onClick} type={onClick ? 'button' : undefined}>
      {Icon && (
        <span className="stat-icon" style={toneStyle}>
          <Icon size={19} />
        </span>
      )}
      <span>
        <strong>{value ?? '—'}</strong>
        <span className="stat-label">{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </Tag>
  )
}

const TONES = {
  brand: { background: 'var(--brand-soft)', color: 'var(--brand)' },
  success: { background: 'var(--success-soft)', color: 'var(--success)' },
  warning: { background: 'var(--warning-soft)', color: 'var(--warning)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  info: { background: 'var(--info-soft)', color: 'var(--info)' },
  violet: { background: 'var(--violet-soft)', color: 'var(--violet)' },
  neutral: { background: 'var(--surface-3)', color: 'var(--muted)' },
}

/** Underlined tabs. `tabs` is [{ id, label, count? }]. */
export function Tabs({ tabs, active, onChange, label = 'Sections' }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={active === tab.id}
          className={active === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count ? <b>{tab.count}</b> : null}
        </button>
      ))}
    </div>
  )
}

export function SegmentedTabs({ options, value, onChange, label }) {
  return (
    <div className="segmented-tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count ? <b>{option.count}</b> : null}
        </button>
      ))}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search…', label = 'Search' }) {
  return (
    <label className="search-input">
      <Search size={16} />
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search">
          <X size={14} />
        </button>
      )}
    </label>
  )
}

/** A compact filter select. `options` is [{ value, label }]; the first may be "All". */
export function FilterSelect({ value, onChange, options, label }) {
  return (
    <select className="filter-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={`${option.value}`} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/**
 * The table used everywhere. On a phone it becomes a list of cards: each cell
 * shows its column label, the `primary` column leads the card.
 *
 * columns: [{ key, label, render?(row), className?, primary? }]
 */
export function DataTable({ columns, rows, rowKey = (row) => row.id, onRowClick, empty, footer, caption }) {
  if (!rows.length && empty) return empty
  return (
    <div className="table-wrap">
      <table className="data-table responsive">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.className} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={[column.className, column.primary ? 'primary' : ''].filter(Boolean).join(' ') || undefined}
                  data-label={column.primary || column.key === 'actions' ? '' : column.label}
                >
                  {column.render ? column.render(row) : (row[column.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}

export function Pagination({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) return null
  return (
    <nav className="pagination" aria-label="Pages">
      <span>
        Page {meta.page} of {meta.totalPages} · {meta.total} total
      </span>
      <div>
        <button className="button button-secondary button-sm" onClick={() => onPage(meta.page - 1)} disabled={meta.page <= 1}>
          <ChevronLeft size={15} /> Previous
        </button>
        <button className="button button-secondary button-sm" onClick={() => onPage(meta.page + 1)} disabled={meta.page >= meta.totalPages}>
          Next <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  )
}

export function Restricted({ text = 'Restricted' }) {
  return (
    <span className="lock-note">
      <LockKeyhole size={13} /> {text}
    </span>
  )
}

// --- Async states -------------------------------------------------------------

export function Spinner({ size = 20 }) {
  return <Loader2 size={size} className="spin" aria-hidden="true" />
}

export function LoadingState({ label = 'Loading…', rows = 0 }) {
  if (rows > 0) {
    return (
      <div className="skeleton-list" aria-busy="true" aria-label={label}>
        {Array.from({ length: rows }).map((_, index) => (
          <div className="skeleton-row" key={index} />
        ))}
      </div>
    )
  }
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Spinner size={20} />
      <span>{label}</span>
    </div>
  )
}

/**
 * One error surface for every failed load. A 403 is not something the user
 * can retry away, so it reads as a permission message without a retry button.
 */
export function ErrorState({ error, onRetry, compact = false }) {
  const isForbidden = error?.status === 403
  const isNotFound = error?.status === 404
  const title = isForbidden ? 'You do not have access to this' : isNotFound ? 'Not found' : 'Could not load this'

  return (
    <div className={`error-state ${compact ? 'error-state-compact' : ''}`} role="alert">
      <span className="error-state-icon">{isForbidden ? <LockKeyhole size={20} /> : <AlertTriangle size={20} />}</span>
      <div>
        <strong>{title}</strong>
        <p>{error?.message || 'Something went wrong.'}</p>
        {error?.requestId && <small className="error-ref">Reference {error.requestId}</small>}
      </div>
      {onRetry && !isForbidden && (
        <button className="button button-secondary" onClick={onRetry} type="button">
          <RotateCcw size={15} /> Try again
        </button>
      )}
    </div>
  )
}

/** Renders whichever of loading / error / content applies. */
export function Async({ loading, error, onRetry, children, label, rows, empty }) {
  if (loading) return <LoadingState label={label} rows={rows} />
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (empty) return empty
  return children
}

/** Inline form-level error, used for a failed submit inside a modal. */
export function FormError({ error }) {
  if (!error) return null
  const message = typeof error === 'string' ? error : error.detailSummary || error.message
  return (
    <div className="form-error" role="alert">
      <XCircle size={16} />
      <span>{message}</span>
    </div>
  )
}

/**
 * Runs a submit handler with saving and error state. The handler receives
 * nothing and may throw an ApiError, which is kept for the form to show.
 */
export function useSubmit(handler) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const submit = useCallback(
    async (event) => {
      event?.preventDefault?.()
      setSaving(true)
      setError(null)
      try {
        return await handler()
      } catch (caught) {
        setError(caught)
        return undefined
      } finally {
        setSaving(false)
      }
    },
    [handler],
  )
  return { submit, saving, error, setError }
}

/**
 * A confirmation step for consequential actions. With `reason` set, a note is
 * required (rejections, reopening payroll) and passed to `onConfirm`.
 */
export function ConfirmDialog({
  open,
  title,
  eyebrow,
  message,
  confirmLabel = 'Confirm',
  tone = 'primary',
  reason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder = '',
  reasonRequired = true,
  onConfirm,
  onClose,
  children,
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (open) {
      setNote('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const confirm = async (event) => {
    event.preventDefault()
    if (reason && reasonRequired && note.trim().length < 3) {
      setError('Please add a short reason.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onConfirm(note.trim())
      onClose()
    } catch (caught) {
      setError(caught)
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} eyebrow={eyebrow} size="sm">
      <form className="simple-form" onSubmit={confirm}>
        {message && <p>{message}</p>}
        {children}
        {reason && (
          <FormField label={reasonLabel}>
            <textarea rows="3" value={note} onChange={(event) => setNote(event.target.value)} placeholder={reasonPlaceholder} />
          </FormField>
        )}
        <FormError error={error} />
        <div className="form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`} disabled={busy}>
            {busy && <Spinner size={15} />} {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
