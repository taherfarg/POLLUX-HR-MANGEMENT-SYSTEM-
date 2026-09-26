import { useEffect, useState } from 'react'
import { Check, Coins, Plus, X } from 'lucide-react'
import {
  Async,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormError,
  FormField,
  Modal,
  Money,
  PageHeader,
  Pagination,
  Panel,
  SegmentedTabs,
  Spinner,
  StatusPill,
  humanize,
  useSubmit,
} from '../components/ui.jsx'
import { EmployeePicker } from '../components/EmployeePicker.jsx'
import { useResource } from '../hooks/useResource.js'
import { currentMonthKey, formatMonth } from '../lib/format.js'
import { approveAdjustment, cancelAdjustment, createAdjustment, fetchAdjustments, rejectAdjustment } from '../api/endpoints.js'

const TYPES = ['BONUS', 'COMMISSION', 'ALLOWANCE', 'DEDUCTION', 'ABSENCE', 'UNPAID_LEAVE', 'ADVANCE', 'OVERTIME', 'OTHER']
const EARNING_TYPES = new Set(['BONUS', 'COMMISSION', 'ALLOWANCE', 'OVERTIME'])

/**
 * One-off earnings and deductions. Each is its own record with its own
 * approval - the person who enters an amount does not approve it - and
 * payroll only picks up approved ones.
 */
export default function AdjustmentsPage({ session, onToast }) {
  const [status, setStatus] = useState('PENDING')
  const [month, setMonth] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [rejecting, setRejecting] = useState(null)
  const [busyId, setBusyId] = useState(null)
  useEffect(() => setPage(1), [status, month])

  const adjustments = useResource(() => fetchAdjustments({ status: status || undefined, payrollMonth: month || undefined, page, pageSize: 25 }), [status, month, page])
  const summary = adjustments.data?.summary ?? {}

  const act = async (row, action) => {
    setBusyId(row.id)
    try {
      if (action === 'approve') await approveAdjustment(row.id)
      else await cancelAdjustment(row.id)
      onToast(action === 'approve' ? 'Approved - it will be included in that month\'s payroll.' : 'Cancelled.')
      adjustments.reload()
    } catch (error) {
      onToast(error.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Bonuses & deductions"
        description="Added to the payroll of their month once approved. A month that is already approved takes no new entries - use the next month."
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Add bonus or deduction
          </button>
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SegmentedTabs
            label="Status"
            value={status}
            onChange={setStatus}
            options={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', ''].map((value) => ({ value, label: value ? humanize(value) : 'All', count: value ? summary[value] : undefined }))}
          />
          <label className="filter-label">
            Month
            <input className="filter-date" type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Payroll month" />
          </label>
        </div>
        <Async loading={adjustments.loading} error={adjustments.error} onRetry={adjustments.reload} rows={6}>
          <DataTable
            caption="Payroll adjustments"
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>{row.description}</small>
                  </div>
                ),
              },
              { key: 'month', label: 'Month', render: (row) => formatMonth(row.payrollMonth) },
              { key: 'type', label: 'Type', render: (row) => humanize(row.type) },
              {
                key: 'amount',
                label: 'Amount',
                className: 'num',
                render: (row) => <Money value={row.amount} currency={row.currency} negative={row.kind === 'DEDUCTION'} />,
              },
              {
                key: 'status',
                label: 'Status',
                render: (row) => (
                  <div>
                    <StatusPill status={row.status} />
                    {row.payrollPeriod && <small>Paid in {row.payrollPeriod.name}</small>}
                  </div>
                ),
              },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) => (
                  <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                    {row.status === 'PENDING' && (
                      <>
                        <button className="button button-success button-sm" onClick={() => act(row, 'approve')} disabled={busyId === row.id}>
                          {busyId === row.id ? <Spinner size={13} /> : <Check size={14} />} Approve
                        </button>
                        <button className="button button-danger button-sm" onClick={() => setRejecting(row)}>
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                    {['PENDING', 'APPROVED'].includes(row.status) && !row.payrollPeriod && (
                      <button className="button button-ghost button-sm" onClick={() => act(row, 'cancel')} disabled={busyId === row.id}>
                        Cancel
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={adjustments.data?.items ?? []}
            empty={<EmptyState icon={Coins} title="Nothing here" text={status === 'PENDING' ? 'No bonus or deduction is waiting for approval.' : undefined} />}
          />
          <Pagination meta={adjustments.data?.meta} onPage={setPage} />
        </Async>
      </Panel>
      <p className="small muted">
        Signed in as {session.email}. You cannot approve an entry you created, or anything on your own pay.
      </p>

      <Modal open={creating} onClose={() => setCreating(false)} title="Add a bonus or deduction">
        {creating && (
          <AdjustmentForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false)
              setStatus('PENDING')
              adjustments.reload()
              onToast('Added. A second HR user or an administrator approves it.')
            }}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(rejecting)}
        title="Reject"
        message={rejecting ? `${humanize(rejecting.type)} for ${rejecting.employee.fullName}: ${rejecting.description}` : ''}
        reason
        confirmLabel="Reject"
        tone="danger"
        onConfirm={async (note) => {
          await rejectAdjustment(rejecting.id, note)
          onToast('Rejected.')
          adjustments.reload()
        }}
        onClose={() => setRejecting(null)}
      />
    </div>
  )
}

function AdjustmentForm({ onCancel, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', payrollMonth: currentMonthKey(), type: 'BONUS', kind: 'EARNING', description: '', amount: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await createAdjustment({
      employeeId: form.employeeId,
      payrollMonth: form.payrollMonth,
      type: form.type,
      kind: form.type === 'OTHER' ? form.kind : undefined,
      description: form.description,
      amount: Number(form.amount),
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <EmployeePicker value={form.employeeId} onChange={(value) => set('employeeId', value)} error={error?.fieldError?.('employeeId')} />
      <div className="two-col">
        <FormField label="Payroll month" error={error?.fieldError?.('payrollMonth')}>
          <input type="month" value={form.payrollMonth} onChange={(e) => set('payrollMonth', e.target.value)} required />
        </FormField>
        <FormField label="Type" error={error?.fieldError?.('type')} hint={form.type === 'OTHER' ? undefined : EARNING_TYPES.has(form.type) ? 'Adds to pay' : 'Deducted from pay'}>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </FormField>
        {form.type === 'OTHER' && (
          <FormField label="Earning or deduction" error={error?.fieldError?.('kind')}>
            <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="EARNING">Earning</option>
              <option value="DEDUCTION">Deduction</option>
            </select>
          </FormField>
        )}
        <FormField label="Amount" error={error?.fieldError?.('amount')}>
          <input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} required />
        </FormField>
      </div>
      <FormField label="Description (shown on the payslip)" error={error?.fieldError?.('description')}>
        <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Sales bonus - Q3 target" required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Add
        </button>
      </div>
    </form>
  )
}
