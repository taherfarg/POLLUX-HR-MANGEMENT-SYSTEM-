import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Avatar } from './ui.jsx'
import { navigationFor } from '../navigation.js'
import { fetchEmployees } from '../api/endpoints.js'

/**
 * Search everything: every page this person can open and, for HR, every
 * person. Ctrl+K (Cmd+K on a Mac) from anywhere, or the search button in the
 * top bar. The arrow keys move, Enter opens, Escape closes.
 */
export default function CommandPalette({ open, onClose, session, onNavigate }) {
  if (!open) return null
  return <Palette onClose={onClose} session={session} onNavigate={onNavigate} />
}

function Palette({ onClose, session, onNavigate }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [people, setPeople] = useState({ term: '', items: [] })
  const inputRef = useRef(null)
  const listId = useId()
  const searchesPeople = session.isManagement

  const pages = useMemo(
    () =>
      navigationFor(session).flatMap((group) =>
        group.items.map((entry) => ({ key: `page:${entry.id}`, kind: 'page', id: entry.id, label: entry.label, hint: group.label ?? '', icon: entry.icon })),
      ),
    [session],
  )

  const term = query.trim().toLowerCase()
  const pageResults = term ? pages.filter((page) => `${page.label} ${page.hint}`.toLowerCase().includes(term)) : pages

  useEffect(() => {
    if (!searchesPeople || term.length < 2) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetchEmployees({ q: term, pageSize: 6 })
        .then((result) => !cancelled && setPeople({ term, items: result.items }))
        .catch(() => !cancelled && setPeople({ term, items: [] }))
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [term, searchesPeople])

  const personResults =
    searchesPeople && term.length >= 2 && people.term === term
      ? people.items.map((person) => ({ key: `person:${person.id}`, kind: 'person', id: person.id, label: person.fullName, hint: `${person.role ?? ''} · ${person.department}`, person }))
      : []
  const results = [...pageResults, ...personResults]
  const current = Math.min(active, Math.max(results.length - 1, 0))

  useEffect(() => setActive(0), [term])
  useEffect(() => {
    inputRef.current?.focus()
    document.body.classList.add('modal-open')
    return () => document.body.classList.remove('modal-open')
  }, [])
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [current, listId])

  const choose = (result) => {
    onClose()
    if (result.kind === 'page') onNavigate(result.id)
    else onNavigate('employees', result.id)
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!results.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current + step + results.length) % results.length)
    } else if (event.key === 'Enter' && results[current]) {
      event.preventDefault()
      choose(results[current])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Search">
        <label>
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchesPeople ? 'Search pages and people…' : 'Search pages…'}
            aria-label={searchesPeople ? 'Search pages and people' : 'Search pages'}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${listId}-${current}` : undefined}
            autoComplete="off"
            spellCheck="false"
          />
          <kbd className="kbd">Esc</kbd>
        </label>

        {results.length ? (
          <ul className="palette-results" id={listId} role="listbox" aria-label="Results">
            {results.map((result, index) => {
              const Icon = result.icon
              const heading = index === 0 || results[index - 1].kind !== result.kind
              return (
                <Fragment key={result.key}>
                  {heading && (
                    <li className="palette-heading" role="presentation">
                      {result.kind === 'page' ? 'Pages' : 'People'}
                    </li>
                  )}
                  <li
                    id={`${listId}-${index}`}
                    className="palette-option"
                    role="option"
                    aria-selected={index === current}
                    onMouseMove={() => index !== current && setActive(index)}
                    onClick={() => choose(result)}
                  >
                    {result.kind === 'page' ? <Icon size={18} aria-hidden="true" /> : <Avatar employee={result.person} size="xs" />}
                    <span>
                      <strong>{result.label}</strong>
                      {result.kind === 'person' && <small>{result.hint}</small>}
                    </span>
                    {result.kind === 'page' && result.hint && <em>{result.hint}</em>}
                  </li>
                </Fragment>
              )
            })}
          </ul>
        ) : (
          <p className="palette-empty">Nothing matches “{query.trim()}”.</p>
        )}

        <footer aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to open
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> to close
          </span>
        </footer>
      </section>
    </div>
  )
}
