import { useEffect, useState } from 'react'
import { History, ShieldCheck } from 'lucide-react'
import {
  Async,
  DataTable,
  EmptyState,
  FilterSelect,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  StatusPill,
  humanize,
} from '../components/ui.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { formatDateTime } from '../lib/format.js'
import { fetchAuditLogs } from '../api/endpoints.js'

const ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'CANCEL',
  'CALCULATE',
  'REVIEW',
  'MARK_PAID',
  'REOPEN',
  'EXPORT',
  'VIEW_SENSITIVE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGE',
]

const ENTITY_TYPES = [
  ['AttendanceRecord', 'Attendance'],
  ['CompanySettings', 'Company settings'],
  ['CompensationRecord', 'Compensation'],
  ['Department', 'Department'],
  ['Document', 'Document'],
  ['Employee', 'Employee'],
  ['Holiday', 'Holiday'],
  ['HolidayCalendar', 'Holiday calendar'],
  ['LeaveBalance', 'Leave balance'],
  ['LeaveType', 'Leave type'],
  ['OvertimeEntry', 'Overtime'],
  ['PayrollAdjustment', 'Bonus / deduction'],
  ['PayrollPeriod', 'Payroll run'],
  ['PayrollRecord', 'Payslip'],
  ['Report', 'Report export'],
  ['Request', 'Request'],
  ['SalaryAdvance', 'Salary advance'],
  ['User', 'User'],
  ['WorkLocation', 'Work location'],
  ['WorkSchedule', 'Work schedule'],
]

const ENTITY_LABELS = Object.fromEntries(ENTITY_TYPES)

const ACTION_TONES = {
  CREATE: 'success',
  APPROVE: 'success',
  MARK_PAID: 'success',
  UPDATE: 'info',
  CALCULATE: 'info',
  REVIEW: 'info',
  DELETE: 'danger',
  REJECT: 'danger',
  LOGIN_FAILED: 'danger',
  CANCEL: 'neutral',
  LOGOUT: 'neutral',
  LOGIN: 'neutral',
  REOPEN: 'warning',
  EXPORT: 'violet',
  VIEW_SENSITIVE: 'violet',
  PASSWORD_CHANGE: 'warning',
}

/**
 * The audit trail. Read-only by design - the API has no endpoint that edits or
 * deletes an entry. Entries can carry before/after values that include pay, so
 * the page is for HR and administrators only (enforced by the API as well).
 */
export default function AuditLogsPage() {
  const [query, setQuery] = useState('')
  const [action, setAction] = useState('')
  const [entityType, setEntityType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [debounced, action, entityType, from, to])

  const logs = useResource(
    () =>
      fetchAuditLogs({
        q: debounced || undefined,
        action: action || undefined,
        entityType: entityType || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
      }),
    [debounced, action, entityType, from, to, page],
  )

  return (
    <div className="page">
      <PageHeader title="Audit logs" description="Every change, approval, payroll step, export and sign-in - who did it, when, and what changed. Entries cannot be edited or deleted." />
      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Summary or person" label="Search the audit trail" />
          <FilterSelect label="Action" value={action} onChange={setAction} options={[{ value: '', label: 'All actions' }, ...ACTIONS.map((value) => ({ value, label: humanize(value) }))]} />
          <FilterSelect
            label="Record type"
            value={entityType}
            onChange={setEntityType}
            options={[{ value: '', label: 'All records' }, ...ENTITY_TYPES.map(([value, label]) => ({ value, label }))]}
          />
          <label className="filter-label">
            From
            <input className="filter-date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          </label>
          <label className="filter-label">
            To
            <input className="filter-date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </label>
        </div>
        <Async loading={logs.loading} error={logs.error} onRetry={logs.reload} rows={8}>
          <DataTable
            caption="Audit entries"
            columns={[
              { key: 'createdAt', label: 'When', render: (row) => <span className="nowrap">{formatDateTime(row.createdAt)}</span> },
              {
                key: 'summary',
                label: 'What happened',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.summary}</strong>
                    <small>{ENTITY_LABELS[row.entityType] ?? row.entityType}</small>
                  </div>
                ),
              },
              { key: 'action', label: 'Action', render: (row) => <StatusPill tone={ACTION_TONES[row.action] ?? 'neutral'} label={humanize(row.action)} /> },
              { key: 'actor', label: 'By', render: (row) => row.actorLabel },
            ]}
            rows={logs.data?.items ?? []}
            onRowClick={setSelected}
            empty={<EmptyState icon={History} title="No audit entries" text="Nothing matches these filters." />}
          />
          <Pagination meta={logs.data?.meta} onPage={setPage} />
        </Async>
      </Panel>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.summary ?? 'Audit entry'} eyebrow={selected ? formatDateTime(selected.createdAt) : undefined} size="lg">
        {selected && <AuditEntry entry={selected} />}
      </Modal>
    </div>
  )
}

function AuditEntry({ entry }) {
  const changes = diffRows(entry.before, entry.after)
  return (
    <div className="stack-form">
      <dl className="detail-list">
        <div>
          <dt>Action</dt>
          <dd>
            <StatusPill tone={ACTION_TONES[entry.action] ?? 'neutral'} label={humanize(entry.action)} />
          </dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
            {entry.entityId ? <small className="mono"> · {entry.entityId}</small> : null}
          </dd>
        </div>
        <div>
          <dt>By</dt>
          <dd>{entry.actorLabel}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd>{[entry.ipAddress, shortAgent(entry.userAgent)].filter(Boolean).join(' · ') || '—'}</dd>
        </div>
      </dl>
      {changes.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Changed values</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.path}>
                  <td className="mono">{change.path}</td>
                  <td className="muted">{change.before}</td>
                  <td>
                    <strong>{change.after}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>This entry records the action only - no field values were stored with it.</span>
        </div>
      )}
    </div>
  )
}

/**
 * Flattens before/after JSON into one row per changed leaf, e.g.
 * "attendance.lateGraceMinutes: 15 -> 10". Unchanged values are left out.
 */
export function diffRows(before, after) {
  const left = flatten(before)
  const right = flatten(after)
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return keys
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => ({ path: key || 'value', before: show(left[key]), after: show(right[key]) }))
}

function flatten(value, prefix = '', out = {}) {
  if (value === null || value === undefined) return out
  if (typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = value
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, out)
    else out[path] = child
  }
  return out
}

function show(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function shortAgent(agent) {
  if (!agent) return ''
  const browser = /(Edg|Chrome|Firefox|Safari)\/[\d.]+/.exec(agent)
  return browser ? browser[0].split('.')[0] : agent.slice(0, 40)
}
