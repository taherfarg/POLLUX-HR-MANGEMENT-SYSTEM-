import { useEffect, useState } from 'react'
import { Check, Plus, Timer, X } from 'lucide-react'
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
import { EmployeePicker } from './AttendancePage.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate, formatMinutes, todayIso } from '../lib/format.js'
import { approveOvertime, cancelOvertime, createOvertime, fetchOvertime, rejectOvertime } from '../api/endpoints.js'

const STATUS_TABS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', '']

/**
 * Overtime from check-outs after the scheduled end, and manual entries by HR.
 * A manager decides their team's minutes; the money is calculated in payroll
 * and shown to HR only.
 */
export default function OvertimePage({ session, onToast }) {
  const { currency } = useCompany()
  const [status, setStatus] = useState('PENDING')
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)
  const [rejecting, setRejecting] = useState(null)
  const [busyId, setBusyId] = useState(null)
  useEffect(() => setPage(1), [status])

  const overtime = useResource(() => fetchOvertime({ status: status || undefined, page, pageSize: 25 }), [status, page])
  const summary = overtime.data?.summary ?? {}

  const approve = async (row) => {
    setBusyId(row.id)
    try {
      await approveOvertime(row.id)
      onToast(`Approved ${formatMinutes(row.minutes)} for ${row.employee.fullName}.`)
      overtime.reload()
    } catch (error) {
      onToast(error.message, 'error')
    } finally {
      setBusyId(null)
    }
  }
  const cancel = async (row) => {
    setBusyId(row.id)
    try {
      await cancelOvertime(row.id)
      onToast('Overtime cancelled.')
      overtime.reload()
    } catch (error) {
      onToast(error.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Overtime"
        description="Overtime is paid only once approved, when company policy requires approval."
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> Add overtime
            </button>
          )
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SegmentedTabs
            label="Status"
            value={status}
            onChange={setStatus}
            options={STATUS_TABS.map((value) => ({ value, label: value ? humanize(value) : 'All', count: value ? summary[value] : undefined }))}
          />
        </div>
        <Async loading={overtime.loading} error={overtime.error} onRetry={overtime.reload} rows={6}>
          <DataTable
            caption="Overtime entries"
            columns={[
              { key: 'date', label: 'Date', render: (row) => formatDate(row.date, { weekday: 'short' }) },
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>{row.employee.department?.name ?? row.employee.jobTitle}</small>
                  </div>
                ),
              },
              { key: 'minutes', label: 'Time', className: 'num', render: (row) => formatMinutes(row.minutes) },
              { key: 'dayType', label: 'Day', render: (row) => (row.dayType === 'WORKING_DAY' ? 'Working day' : humanize(row.dayType)) },
              { key: 'rate', label: 'Rate', className: 'num', render: (row) => `× ${row.rateMultiplier}` },
              { key: 'source', label: 'Source', render: (row) => (row.source === 'MANUAL' ? 'Manual' : 'Attendance') },
              {
                key: 'payroll',
                label: 'Paid in',
                render: (row) =>
                  row.payroll ? (
                    <div>
                      <strong>{row.payroll.period.name}</strong>
                      {row.payroll.amount !== undefined && (
                        <small>
                          <Money value={row.payroll.amount} currency={currency} />
                        </small>
                      )}
                    </div>
                  ) : (
                    '—'
                  ),
              },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) => (
                  <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                    {row.status === 'PENDING' && row.employee.id !== session.employee?.id && (
                      <>
                        <button className="button button-success button-sm" onClick={() => approve(row)} disabled={busyId === row.id}>
                          {busyId === row.id ? <Spinner size={13} /> : <Check size={14} />} Approve
                        </button>
                        <button className="button button-danger button-sm" onClick={() => setRejecting(row)}>
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                    {session.isManagement && ['PENDING', 'APPROVED'].includes(row.status) && !row.payroll && (
                      <button className="button button-ghost button-sm" onClick={() => cancel(row)} disabled={busyId === row.id}>
                        Cancel
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={overtime.data?.items ?? []}
            empty={<EmptyState icon={Timer} title="No overtime here" text={status === 'PENDING' ? 'Nothing is waiting for a decision.' : 'No entries with this status.'} />}
          />
          <Pagination meta={overtime.data?.meta} onPage={setPage} />
        </Async>
      </Panel>

      <ConfirmDialog
        open={Boolean(rejecting)}
        title="Reject overtime"
        eyebrow={rejecting ? `${rejecting.employee.fullName} · ${formatDate(rejecting.date)}` : ''}
        message="The employee sees your reason."
        reason
        reasonLabel="Reason"
        confirmLabel="Reject"
        tone="danger"
        onConfirm={async (note) => {
          await rejectOvertime(rejecting.id, note)
          onToast('Overtime rejected.')
          overtime.reload()
        }}
        onClose={() => setRejecting(null)}
      />

      <Modal open={adding} onClose={() => setAdding(false)} title="Add overtime" eyebrow="Manual entry · audited">
        {adding && (
          <ManualOvertimeForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false)
              overtime.reload()
              onToast('Overtime added.')
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function ManualOvertimeForm({ onCancel, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', date: todayIso(), hours: '', dayType: 'WORKING_DAY', reason: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await createOvertime({
      employeeId: form.employeeId,
      date: form.date,
      minutes: Math.round(Number(form.hours) * 60),
      dayType: form.dayType,
      reason: form.reason,
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <EmployeePicker value={form.employeeId} onChange={(value) => set('employeeId', value)} error={error?.fieldError?.('employeeId')} />
      <div className="three-col">
        <FormField label="Date" error={error?.fieldError?.('date')}>
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
        </FormField>
        <FormField label="Hours" error={error?.fieldError?.('minutes')}>
          <input type="number" min="0.25" step="0.25" value={form.hours} onChange={(e) => set('hours', e.target.value)} placeholder="2.5" />
        </FormField>
        <FormField label="Day">
          <select value={form.dayType} onChange={(e) => set('dayType', e.target.value)}>
            <option value="WORKING_DAY">Working day</option>
            <option value="WEEKEND">Rest day</option>
            <option value="HOLIDAY">Holiday</option>
          </select>
        </FormField>
      </div>
      <FormField label="Reason" error={error?.fieldError?.('reason')}>
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Weekend vehicle delivery event" required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Add overtime
        </button>
      </div>
    </form>
  )
}
