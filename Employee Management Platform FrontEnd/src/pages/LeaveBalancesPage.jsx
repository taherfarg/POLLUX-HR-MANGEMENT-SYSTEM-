import { useEffect, useState } from 'react'
import { CalendarPlus, Pencil, Scale } from 'lucide-react'
import {
  Async,
  DataTable,
  EmptyState,
  FilterSelect,
  FormError,
  FormField,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  Spinner,
  useSubmit,
} from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { adjustLeaveBalance, fetchLeaveBalances, fetchLeaveTypes, generateLeaveBalances } from '../api/endpoints.js'

const thisYear = new Date().getFullYear()

/** Everyone's leave: entitlement, carried over, used, pending and what is left. */
export default function LeaveBalancesPage({ session, onToast }) {
  const { departments, locations } = useCompany()
  const leaveTypes = useResource(() => fetchLeaveTypes(), [])
  const [year, setYear] = useState(thisYear)
  const [departmentId, setDepartmentId] = useState('')
  const [workLocationId, setWorkLocationId] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [adjusting, setAdjusting] = useState(null)
  const [generating, setGenerating] = useState(false)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [year, departmentId, workLocationId, leaveTypeId, debounced])

  const balances = useResource(
    () =>
      fetchLeaveBalances({
        year,
        departmentId: departmentId || undefined,
        workLocationId: workLocationId || undefined,
        leaveTypeId: leaveTypeId || undefined,
        q: debounced || undefined,
        page,
        pageSize: 50,
      }),
    [year, departmentId, workLocationId, leaveTypeId, debounced, page],
  )
  const totals = balances.data?.totals

  return (
    <div className="page">
      <PageHeader
        title="Leave balances"
        description="Available = entitlement + carried over − used − pending."
        actions={
          session.isManagement && (
            <button className="button button-secondary" onClick={() => setGenerating(true)}>
              <CalendarPlus size={16} /> Set up a new year
            </button>
          )
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Employee name or number" label="Search balances" />
          <FilterSelect
            label="Year"
            value={String(year)}
            onChange={(value) => setYear(Number(value))}
            options={[thisYear - 1, thisYear, thisYear + 1].map((value) => ({ value: String(value), label: String(value) }))}
          />
          <FilterSelect
            label="Leave type"
            value={leaveTypeId}
            onChange={setLeaveTypeId}
            options={[{ value: '', label: 'All leave types' }, ...(leaveTypes.data ?? []).map((type) => ({ value: type.id, label: type.name }))]}
          />
          <FilterSelect
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={[{ value: '', label: 'All departments' }, ...departments.map((item) => ({ value: item.id, label: item.name }))]}
          />
          <FilterSelect
            label="Work location"
            value={workLocationId}
            onChange={setWorkLocationId}
            options={[{ value: '', label: 'All locations' }, ...locations.map((item) => ({ value: item.id, label: item.name }))]}
          />
        </div>
        <Async loading={balances.loading} error={balances.error} onRetry={balances.reload} rows={8}>
          <DataTable
            caption="Leave balances"
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>{row.employee.department?.name ?? row.employee.employeeNumber}</small>
                  </div>
                ),
              },
              {
                key: 'type',
                label: 'Leave type',
                render: (row) => (
                  <span className="chip">
                    <i className="chip-dot" style={{ background: row.leaveType.colorHex }} />
                    {row.leaveType.name}
                  </span>
                ),
              },
              { key: 'entitledDays', label: 'Entitlement', className: 'num' },
              { key: 'carriedOverDays', label: 'Carried', className: 'num' },
              { key: 'usedDays', label: 'Used', className: 'num' },
              { key: 'pendingDays', label: 'Pending', className: 'num' },
              { key: 'availableDays', label: 'Available', className: 'num', render: (row) => <strong>{row.availableDays}</strong> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  session.isManagement ? (
                    <button className="button button-ghost button-sm" onClick={() => setAdjusting(row)} aria-label={`Adjust ${row.employee.fullName} ${row.leaveType.name}`}>
                      <Pencil size={14} /> Adjust
                    </button>
                  ) : null,
              },
            ]}
            rows={balances.data?.items ?? []}
            empty={<EmptyState icon={Scale} title="No balances for this year" text={session.isManagement ? 'Use "Set up a new year" to create them.' : undefined} />}
          />
          {totals && (
            <div className="summary-strip">
              <span>
                Entitlement<strong>{totals.entitledDays}</strong>
              </span>
              <span>
                Carried<strong>{totals.carriedOverDays}</strong>
              </span>
              <span>
                Used<strong>{totals.usedDays}</strong>
              </span>
              <span>
                Pending<strong>{totals.pendingDays}</strong>
              </span>
              <span>
                Available<strong>{totals.availableDays}</strong>
              </span>
            </div>
          )}
          <Pagination meta={balances.data?.meta} onPage={setPage} />
        </Async>
      </Panel>

      <Modal open={Boolean(adjusting)} onClose={() => setAdjusting(null)} title="Adjust leave balance" eyebrow={adjusting ? `${adjusting.employee.fullName} · ${adjusting.leaveType.name} ${adjusting.year}` : ''}>
        {adjusting && (
          <AdjustForm
            balance={adjusting}
            onCancel={() => setAdjusting(null)}
            onSaved={() => {
              setAdjusting(null)
              balances.reload()
              onToast('Balance adjusted.')
            }}
          />
        )}
      </Modal>
      <Modal open={generating} onClose={() => setGenerating(false)} title="Set up a new year" eyebrow="Leave balances">
        {generating && (
          <GenerateForm
            onCancel={() => setGenerating(false)}
            onSaved={(result) => {
              setGenerating(false)
              setYear(result.year)
              balances.reload()
              onToast(`${result.created} balance(s) created for ${result.year}${result.carriedOver ? `, ${result.carriedOver} with carried-over days` : ''}.`)
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function AdjustForm({ balance, onCancel, onSaved }) {
  const [form, setForm] = useState({ entitledDays: balance.entitledDays, carriedOverDays: balance.carriedOverDays, reason: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await adjustLeaveBalance(balance.id, {
      entitledDays: Number(form.entitledDays),
      carriedOverDays: Number(form.carriedOverDays),
      reason: form.reason,
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <p className="muted">
        Used {balance.usedDays} and pending {balance.pendingDays} days stay as they are; the entitlement cannot go below them.
      </p>
      <div className="two-col">
        <FormField label="Entitlement (days)" error={error?.fieldError?.('entitledDays')}>
          <input type="number" min="0" step="0.5" value={form.entitledDays} onChange={(e) => set('entitledDays', e.target.value)} />
        </FormField>
        <FormField label="Carried over (days)" error={error?.fieldError?.('carriedOverDays')}>
          <input type="number" min="0" step="0.5" value={form.carriedOverDays} onChange={(e) => set('carriedOverDays', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Reason" error={error?.fieldError?.('reason')} hint="Recorded in the audit trail.">
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Two extra days agreed at hiring" required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Save
        </button>
      </div>
    </form>
  )
}

function GenerateForm({ onCancel, onSaved }) {
  const [form, setForm] = useState({ year: thisYear + 1, carryOver: true, prorateNewJoiners: true })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    onSaved(await generateLeaveBalances({ year: Number(form.year), carryOver: form.carryOver, prorateNewJoiners: form.prorateNewJoiners }))
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <p className="muted">
        Creates a balance for every current employee and leave type that does not have one yet. Existing balances are never changed, so running it twice is
        safe.
      </p>
      <FormField label="Year" error={error?.fieldError?.('year')}>
        <input type="number" min="2000" max="2100" value={form.year} onChange={(e) => set('year', e.target.value)} />
      </FormField>
      <label className="check">
        <input type="checkbox" checked={form.carryOver} onChange={(e) => set('carryOver', e.target.checked)} /> Carry unused days over, up to each leave type&apos;s limit
      </label>
      <label className="check">
        <input type="checkbox" checked={form.prorateNewJoiners} onChange={(e) => set('prorateNewJoiners', e.target.checked)} /> Pro-rate people who join during the year
      </label>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Create balances
        </button>
      </div>
    </form>
  )
}
