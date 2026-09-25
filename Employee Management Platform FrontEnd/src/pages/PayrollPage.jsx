import { useState } from 'react'
import { ArrowLeft, BadgeCheck, Banknote, Calculator, CheckCircle2, Lock, Plus, ReceiptText, RotateCcw, ShieldCheck, Wallet, X } from 'lucide-react'
import {
  Async,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormError,
  FormField,
  Modal,
  Money,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
  humanize,
  useSubmit,
} from '../components/ui.jsx'
import { PayslipView } from '../components/payroll.jsx'
import { useResource } from '../hooks/useResource.js'
import { openFile } from '../lib/download.js'
import { formatDate, formatDateTime } from '../lib/format.js'
import {
  approvePayrollPeriod,
  calculatePayrollPeriod,
  cancelPayrollPeriod,
  createPayrollPeriod,
  fetchPayrollPeriod,
  fetchPayrollPeriods,
  fetchPayrollRecord,
  markPayrollPaid,
  payslipPdfPath,
  reopenPayrollPeriod,
  reviewPayrollPeriod,
} from '../api/endpoints.js'

const STEPS = ['DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID']

/** Payroll runs: the list, or one run's register when the URL names it. */
export default function PayrollPage({ session, param, navigate, onToast }) {
  if (param) return <PayrollRun periodId={param} session={session} navigate={navigate} onToast={onToast} />
  return <PayrollRuns navigate={navigate} onToast={onToast} />
}

function PayrollRuns({ navigate, onToast }) {
  const periods = useResource(() => fetchPayrollPeriods(), [])
  const [creating, setCreating] = useState(false)

  return (
    <div className="page">
      <PageHeader
        title="Payroll runs"
        description="Each month: calculate, review, approve (by a second person), then mark as paid. Approved months are locked."
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New payroll run
          </button>
        }
      />
      <Panel flush>
        <Async loading={periods.loading} error={periods.error} onRetry={periods.reload} rows={5}>
          <DataTable
            caption="Payroll runs"
            onRowClick={(row) => navigate('payroll', row.id)}
            columns={[
              {
                key: 'name',
                label: 'Month',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.name}</strong>
                    <small>Pay date {formatDate(row.payDate)}</small>
                  </div>
                ),
              },
              { key: 'employeeCount', label: 'Employees', className: 'num' },
              { key: 'totalGross', label: 'Gross', className: 'num', render: (row) => <Money value={row.totalGross} currency={row.currency} /> },
              { key: 'totalDeductions', label: 'Deductions', className: 'num', render: (row) => <Money value={row.totalDeductions} currency={row.currency} /> },
              { key: 'totalNet', label: 'Net', className: 'num', render: (row) => <strong><Money value={row.totalNet} currency={row.currency} /></strong> },
              {
                key: 'status',
                label: 'Status',
                render: (row) => (
                  <span className="button-row">
                    <StatusPill status={row.status} />
                    {row.isLocked && <Lock size={13} className="muted" aria-label="Locked" />}
                  </span>
                ),
              },
            ]}
            rows={periods.data ?? []}
            empty={<EmptyState icon={Wallet} title="No payroll runs yet" text="Start with the current month." />}
          />
        </Async>
      </Panel>
      <Modal open={creating} onClose={() => setCreating(false)} title="New payroll run">
        {creating && (
          <CreateForm
            onCancel={() => setCreating(false)}
            onSaved={(period) => {
              setCreating(false)
              onToast(`Payroll for ${period.name} created.`)
              navigate('payroll', period.id)
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function CreateForm({ onCancel, onSaved }) {
  const now = new Date()
  const [form, setForm] = useState({ month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, payDate: '', notes: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const [year, month] = form.month.split('-').map(Number)
    onSaved(await createPayrollPeriod({ year, month, payDate: form.payDate || undefined, notes: form.notes || undefined }))
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        <FormField label="Month" error={error?.fieldError?.('month')}>
          <input type="month" value={form.month} onChange={(e) => set('month', e.target.value)} required />
        </FormField>
        <FormField label="Pay date" hint="Empty: the company payroll day" error={error?.fieldError?.('payDate')}>
          <input type="date" value={form.payDate} onChange={(e) => set('payDate', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Notes">
        <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Create
        </button>
      </div>
    </form>
  )
}

function PayrollRun({ periodId, session, navigate, onToast }) {
  const period = useResource(() => fetchPayrollPeriod(periodId), [periodId])
  const [busy, setBusy] = useState(null)
  const [notes, setNotes] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [recordId, setRecordId] = useState(null)

  const run = async (label, action) => {
    setBusy(label)
    try {
      const result = await action()
      period.reload()
      return result
    } catch (error) {
      onToast(error.message, 'error')
      return undefined
    } finally {
      setBusy(null)
    }
  }

  if (period.loading) return <Async loading rows={8} />
  if (period.error) return <ErrorState error={period.error} onRetry={period.reload} />
  const data = period.data
  const stepIndex = STEPS.indexOf(data.status)

  const calculate = () =>
    run('calculate', async () => {
      const result = await calculatePayrollPeriod(periodId)
      setNotes({ skipped: result.skipped ?? [], warnings: result.warnings ?? [] })
      onToast(`Calculated ${result.employeeCount} payslip(s). Review, then ask a second person to approve.`)
    })

  return (
    <div className="page">
      <div>
        <button className="button button-ghost button-sm" onClick={() => navigate('payroll')}>
          <ArrowLeft size={15} /> All payroll runs
        </button>
      </div>
      <PageHeader
        title={`Payroll · ${data.name}`}
        description={`${formatDate(data.startDate)} – ${formatDate(data.endDate)} · pay date ${formatDate(data.payDate)}`}
        actions={
          <>
            {['DRAFT', 'CALCULATED', 'REVIEWED'].includes(data.status) && (
              <button className="button button-secondary" onClick={calculate} disabled={Boolean(busy)}>
                {busy === 'calculate' ? <Spinner size={15} /> : <Calculator size={15} />} {data.status === 'DRAFT' ? 'Calculate' : 'Recalculate'}
              </button>
            )}
            {data.status === 'CALCULATED' && (
              <button className="button button-primary" onClick={() => run('review', async () => { await reviewPayrollPeriod(periodId); onToast('Marked as reviewed.') })} disabled={Boolean(busy)}>
                {busy === 'review' ? <Spinner size={15} /> : <BadgeCheck size={15} />} Mark reviewed
              </button>
            )}
            {data.status === 'REVIEWED' && (
              <button className="button button-primary" onClick={() => setDialog('approve')} disabled={Boolean(busy)}>
                <ShieldCheck size={15} /> Approve
              </button>
            )}
            {data.status === 'APPROVED' && (
              <button className="button button-success" onClick={() => setDialog('paid')} disabled={Boolean(busy)}>
                <Banknote size={15} /> Mark as paid
              </button>
            )}
            {data.status === 'APPROVED' && session.isAdmin && (
              <button className="button button-ghost" onClick={() => setDialog('reopen')}>
                <RotateCcw size={15} /> Reopen
              </button>
            )}
            {['DRAFT', 'CALCULATED', 'REVIEWED'].includes(data.status) && (
              <button className="button button-ghost" onClick={() => setDialog('cancel')}>
                <X size={15} /> Cancel run
              </button>
            )}
          </>
        }
      />

      <div className="steps" aria-label="Payroll progress">
        {STEPS.map((step, index) => (
          <span key={step} className={index < stepIndex ? 'done' : index === stepIndex ? 'current' : ''}>
            {index < stepIndex && <CheckCircle2 size={13} />} {humanize(step)}
          </span>
        ))}
        {data.status === 'CANCELLED' && <StatusPill status="CANCELLED" />}
      </div>

      <section className="stat-grid">
        <Summary label="Employees" value={data.employeeCount} />
        <Summary label="Gross" value={<Money value={data.totalGross} currency={data.currency} />} />
        <Summary label="Deductions" value={<Money value={data.totalDeductions} currency={data.currency} />} />
        <Summary label="Net to pay" value={<Money value={data.totalNet} currency={data.currency} />} />
      </section>

      {data.isLocked && (
        <div className="notice notice-success">
          <Lock size={16} />
          <span>
            <strong>Locked.</strong> Approved {formatDateTime(data.approvedAt)}
            {data.paidAt ? `, paid ${formatDate(data.paidAt)}${data.paymentReference ? ` (${data.paymentReference})` : ''}` : ''}. Attendance, overtime, advances and
            adjustments for this month can no longer change{session.isAdmin && data.status === 'APPROVED' ? ' unless an administrator reopens it' : ''}.
          </span>
        </div>
      )}
      {data.status === 'REVIEWED' && (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>
            Approval re-runs the calculation and is refused if anything changed since review. When the company requires it, the person who calculated cannot
            approve.
          </span>
        </div>
      )}
      {notes && (notes.skipped.length > 0 || notes.warnings.length > 0) && (
        <div className="notice notice-warning">
          <ReceiptText size={16} />
          <span>
            {notes.skipped.length > 0 && (
              <>
                <strong>Not included:</strong> {notes.skipped.map((entry) => `${entry.fullName} (${entry.reason})`).join('; ')}.{' '}
              </>
            )}
            {notes.warnings.length > 0 && (
              <>
                <strong>Check:</strong> {notes.warnings.map((entry) => `${entry.fullName}: ${entry.warnings.join(', ')}`).join('; ')}
              </>
            )}
          </span>
        </div>
      )}

      <Panel title="Register" description="Opening this register is recorded in the audit trail." flush>
        <DataTable
          caption={`Payroll register ${data.name}`}
          onRowClick={(row) => setRecordId(row.id)}
          columns={[
            {
              key: 'employee',
              label: 'Employee',
              primary: true,
              render: (row) => (
                <div>
                  <strong>{row.employee.fullName}</strong>
                  <small>
                    {row.employee.employeeNumber} · {row.employee.departmentName ?? '—'}
                  </small>
                </div>
              ),
            },
            { key: 'basic', label: 'Basic', className: 'num', render: (row) => <Money value={row.salary.baseSalary} currency={row.currency} /> },
            { key: 'gross', label: 'Gross', className: 'num', render: (row) => <Money value={row.grossEarnings} currency={row.currency} /> },
            { key: 'deductions', label: 'Deductions', className: 'num', render: (row) => <Money value={row.totalDeductions} currency={row.currency} /> },
            { key: 'net', label: 'Net', className: 'num', render: (row) => <strong><Money value={row.netSalary} currency={row.currency} /></strong> },
            { key: 'absent', label: 'Absent', className: 'num', render: (row) => row.absentDays || '—' },
            {
              key: 'flags',
              label: '',
              render: (row) => (row.warnings?.length ? <StatusPill tone="danger" label="Check" /> : row.hasPayslip ? <StatusPill tone="success" label="Payslip" /> : null),
            },
          ]}
          rows={data.records ?? []}
          empty={<EmptyState icon={Calculator} title="Not calculated yet" text="Calculate to build every employee's payslip from salary, attendance, overtime, adjustments and advances." />}
        />
      </Panel>

      <RecordModal recordId={recordId} onClose={() => setRecordId(null)} onToast={onToast} />

      <ConfirmDialog
        open={dialog === 'approve'}
        title={`Approve payroll for ${data.name}`}
        message="Approval re-checks every figure, links overtime, adjustments and advance instalments to the payslips, stores a PDF payslip for each employee and locks the month."
        confirmLabel="Approve payroll"
        onConfirm={async () => {
          await approvePayrollPeriod(periodId)
          onToast(`Payroll for ${data.name} approved. Payslips are available.`)
          period.reload()
        }}
        onClose={() => setDialog(null)}
      />
      <MarkPaidDialog
        open={dialog === 'paid'}
        period={data}
        onClose={() => setDialog(null)}
        onSaved={() => {
          onToast(`Payroll for ${data.name} marked as paid.`)
          period.reload()
        }}
      />
      <ConfirmDialog
        open={dialog === 'reopen'}
        title="Reopen approved payroll"
        message="Payslips are withdrawn, instalments become due again and the month unlocks for correction. It then needs review and approval again."
        reason
        reasonLabel="Why is it being reopened?"
        confirmLabel="Reopen"
        tone="danger"
        onConfirm={async (reason) => {
          await reopenPayrollPeriod(periodId, reason)
          onToast('Payroll reopened.')
          period.reload()
        }}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        title="Cancel this payroll run"
        message="The run is set aside; the month can be started again later."
        reason
        reasonRequired={false}
        reasonLabel="Reason (optional)"
        confirmLabel="Cancel run"
        tone="danger"
        onConfirm={async (reason) => {
          await cancelPayrollPeriod(periodId, reason)
          onToast('Payroll run cancelled.')
          period.reload()
        }}
        onClose={() => setDialog(null)}
      />
    </div>
  )
}

function Summary({ label, value }) {
  return (
    <div className="stat-card">
      <span>
        <strong style={{ fontSize: 20 }}>{value}</strong>
        <span className="stat-label">{label}</span>
      </span>
    </div>
  )
}

function MarkPaidDialog({ open, period, onClose, onSaved }) {
  const [form, setForm] = useState({ paidOn: period.payDate ?? '', paymentReference: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await markPayrollPaid(period.id, { paidOn: form.paidOn || undefined, paymentReference: form.paymentReference || undefined })
    onSaved()
    onClose()
  })
  return (
    <Modal open={open} onClose={onClose} title="Mark payroll as paid" eyebrow={period.name} size="sm">
      <form className="simple-form" onSubmit={submit} noValidate>
        <p className="muted">After this the payroll is final. Later corrections go into the next month as adjustments.</p>
        <FormField label="Paid on" error={error?.fieldError?.('paidOn')}>
          <input type="date" value={form.paidOn} onChange={(e) => set('paidOn', e.target.value)} />
        </FormField>
        <FormField label="Payment reference" hint="e.g. the WPS or bank batch reference">
          <input value={form.paymentReference} onChange={(e) => set('paymentReference', e.target.value)} />
        </FormField>
        <FormError error={error} />
        <div className="form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-success" disabled={saving}>
            {saving && <Spinner size={15} />} Mark as paid
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RecordModal({ recordId, onClose, onToast }) {
  const record = useResource(() => fetchPayrollRecord(recordId), [recordId], { enabled: Boolean(recordId) })
  if (!recordId) return null
  const open = async () => {
    try {
      await openFile(payslipPdfPath(recordId))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }
  return (
    <Modal open onClose={onClose} title={record.data?.employee.fullName ?? 'Payslip'} eyebrow={record.data ? `${record.data.period.name} · ${record.data.employee.employeeNumber}` : ''} size="lg">
      <Async loading={record.loading} error={record.error} rows={6}>
        {record.data && (
          <>
            <PayslipView record={record.data} />
            {record.data.hasPayslip && (
              <div className="form-actions" style={{ marginTop: 14 }}>
                <button className="button button-secondary" onClick={open}>
                  <ReceiptText size={15} /> Open PDF payslip
                </button>
              </div>
            )}
          </>
        )}
      </Async>
    </Modal>
  )
}
