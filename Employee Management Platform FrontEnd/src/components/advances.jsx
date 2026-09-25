import { useState } from 'react'
import { Banknote, CalendarClock, Check, X } from 'lucide-react'
import { Async, ConfirmDialog, DataTable, FormError, FormField, Modal, Money, RequestFact, Spinner, StatusPill, useSubmit } from './ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { currentMonthKey, formatDate, formatMonth, shiftMonthKey } from '../lib/format.js'
import { approveAdvance, cancelAdvance, fetchAdvance, markAdvancePaid, rejectAdvance, requestAdvance, rescheduleAdvance } from '../api/endpoints.js'

/**
 * One salary advance: amounts, the instalment plan and - for HR - the next
 * action its status allows. Repaid and remaining always come from the
 * instalments themselves.
 */
export function AdvanceDetail({ advanceId, mode = 'own', onClose, onChanged, onToast }) {
  const advance = useResource(() => fetchAdvance(advanceId), [advanceId], { enabled: Boolean(advanceId) })
  const [action, setAction] = useState(null)
  if (!advanceId) return null
  const data = advance.data
  const hr = mode === 'hr'

  const done = (message) => {
    setAction(null)
    advance.reload()
    onChanged?.()
    onToast(message)
  }

  return (
    <Modal open onClose={onClose} title={data ? `Salary advance ${data.reference}` : 'Salary advance'} eyebrow={data?.employee.fullName} size="lg">
      <Async loading={advance.loading} error={advance.error} onRetry={advance.reload} rows={5}>
        {data && (
          <div className="page">
            <div className="request-person">
              <div>
                <strong>{data.employee.fullName}</strong>
                <span>
                  {data.employee.jobTitle} · requested {formatDate(data.requestDate)}
                </span>
              </div>
              <StatusPill status={data.status} />
            </div>
            <div className="request-facts">
              <RequestFact icon={Banknote} label="Original advance" value={<Money value={data.originalAmount} currency={data.currency} />} />
              <RequestFact icon={Check} label="Repaid" value={<Money value={data.repaidAmount} currency={data.currency} />} />
              <RequestFact icon={Banknote} label="Remaining" value={<Money value={data.remainingAmount} currency={data.currency} />} />
              <RequestFact
                icon={CalendarClock}
                label="Next instalment"
                value={data.nextInstallment ? `${formatMonth(data.nextInstallment.dueMonth)} · ${data.currency} ${data.nextInstallment.amount.toFixed(2)}` : '—'}
              />
            </div>
            {data.reason && (
              <div className="reason-box">
                <p className="eyebrow">Reason</p>
                <blockquote>{data.reason}</blockquote>
              </div>
            )}
            {data.decisionNote && (
              <div className="reason-box">
                <p className="eyebrow">HR note</p>
                <blockquote>{data.decisionNote}</blockquote>
              </div>
            )}
            {data.status === 'PENDING' && (
              <p className="muted">
                Requested <Money value={data.requestedAmount} currency={data.currency} />
                {data.requestedInstallments ? ` over ${data.requestedInstallments} month(s)` : ''}.
              </p>
            )}
            {data.installments.length > 0 && (
              <DataTable
                caption="Instalments"
                columns={[
                  { key: 'sequence', label: '#', render: (row) => row.sequence },
                  { key: 'dueMonth', label: 'Month', primary: true, render: (row) => <strong>{row.dueMonthLabel}</strong> },
                  { key: 'amount', label: 'Amount', className: 'num', render: (row) => <Money value={row.amount} currency={data.currency} /> },
                  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
                  { key: 'payroll', label: 'Payroll', render: (row) => row.payrollPeriod?.name ?? '—' },
                ]}
                rows={data.installments}
              />
            )}

            <div className="request-actions">
              {hr && data.status === 'PENDING' && (
                <>
                  <button className="button button-danger" onClick={() => setAction('reject')}>
                    <X size={15} /> Reject
                  </button>
                  <button className="button button-primary" onClick={() => setAction('approve')}>
                    <Check size={15} /> Approve
                  </button>
                </>
              )}
              {hr && data.status === 'APPROVED' && (
                <button className="button button-success" onClick={() => setAction('paid')}>
                  <Banknote size={15} /> Mark as paid out
                </button>
              )}
              {hr && ['APPROVED', 'PAID', 'ACTIVE'].includes(data.status) && (
                <button className="button button-secondary" onClick={() => setAction('reschedule')}>
                  <CalendarClock size={15} /> Change repayment plan
                </button>
              )}
              {((hr && ['PENDING', 'APPROVED'].includes(data.status)) || (!hr && data.status === 'PENDING')) && (
                <button className="button button-ghost" onClick={() => setAction('cancel')}>
                  {hr ? 'Cancel advance' : 'Withdraw request'}
                </button>
              )}
            </div>
          </div>
        )}
      </Async>

      {data && action === 'approve' && <ApproveModal advance={data} onClose={() => setAction(null)} onSaved={() => done(`${data.reference} approved.`)} />}
      {data && action === 'paid' && <PaidModal advance={data} onClose={() => setAction(null)} onSaved={() => done(`${data.reference} marked as paid out.`)} />}
      {data && action === 'reschedule' && <RescheduleModal advance={data} onClose={() => setAction(null)} onSaved={() => done('Repayment plan updated.')} />}
      <ConfirmDialog
        open={action === 'reject'}
        title="Reject advance"
        message="The employee sees your reason."
        reason
        confirmLabel="Reject"
        tone="danger"
        onConfirm={async (note) => {
          await rejectAdvance(advanceId, note)
          done('Advance rejected.')
        }}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action === 'cancel'}
        title={hr ? 'Cancel advance' : 'Withdraw request'}
        message={hr ? 'The advance is cancelled before any money is paid.' : 'Your request is withdrawn.'}
        confirmLabel={hr ? 'Cancel advance' : 'Withdraw'}
        tone="danger"
        onConfirm={async () => {
          await cancelAdvance(advanceId)
          done(hr ? 'Advance cancelled.' : 'Request withdrawn.')
        }}
        onClose={() => setAction(null)}
      />
    </Modal>
  )
}

function ApproveModal({ advance, onClose, onSaved }) {
  const [form, setForm] = useState({
    approvedAmount: advance.requestedAmount,
    numberOfInstallments: advance.requestedInstallments ?? 1,
    repaymentStartMonth: shiftMonthKey(currentMonthKey(), 1),
    note: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const perMonth = Number(form.numberOfInstallments) > 0 ? Number(form.approvedAmount) / Number(form.numberOfInstallments) : 0
  const { submit, saving, error } = useSubmit(async () => {
    await approveAdvance(advance.id, {
      approvedAmount: Number(form.approvedAmount),
      numberOfInstallments: Number(form.numberOfInstallments),
      repaymentStartMonth: form.repaymentStartMonth,
      note: form.note || undefined,
    })
    onSaved()
  })
  return (
    <Modal open onClose={onClose} title={`Approve ${advance.reference}`} eyebrow={advance.employee.fullName}>
      <form className="simple-form" onSubmit={submit} noValidate>
        <div className="two-col">
          <FormField label={`Approved amount (${advance.currency})`} error={error?.fieldError?.('approvedAmount')} hint={`Requested ${advance.requestedAmount}`}>
            <input type="number" min="1" step="0.01" value={form.approvedAmount} onChange={(e) => set('approvedAmount', e.target.value)} />
          </FormField>
          <FormField label="Instalments" error={error?.fieldError?.('numberOfInstallments')}>
            <input type="number" min="1" max="60" value={form.numberOfInstallments} onChange={(e) => set('numberOfInstallments', e.target.value)} />
          </FormField>
          <FormField label="First deduction" error={error?.fieldError?.('repaymentStartMonth')}>
            <input type="month" value={form.repaymentStartMonth} onChange={(e) => set('repaymentStartMonth', e.target.value)} />
          </FormField>
        </div>
        <p className="muted small">
          About {advance.currency} {perMonth ? perMonth.toFixed(2) : '—'} per month from {formatMonth(form.repaymentStartMonth)}; the server splits the amount exactly,
          with any remainder on the last instalment.
        </p>
        <FormField label="Note for the employee">
          <input value={form.note} onChange={(e) => set('note', e.target.value)} />
        </FormField>
        <FormError error={error} />
        <div className="form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving && <Spinner size={15} />} Approve
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PaidModal({ advance, onClose, onSaved }) {
  const [reference, setReference] = useState('')
  const { submit, saving, error } = useSubmit(async () => {
    await markAdvancePaid(advance.id, { paymentReference: reference || undefined })
    onSaved()
  })
  return (
    <Modal open onClose={onClose} title="Mark as paid out" eyebrow={advance.reference} size="sm">
      <form className="simple-form" onSubmit={submit} noValidate>
        <p className="muted">Repayment starts with the first instalment month once the money has been paid.</p>
        <FormField label="Payment reference">
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank transfer reference" />
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

function RescheduleModal({ advance, onClose, onSaved }) {
  const [form, setForm] = useState({
    numberOfInstallments: advance.installments.filter((row) => row.status === 'SCHEDULED').length || 1,
    repaymentStartMonth: advance.nextInstallment?.dueMonth ?? shiftMonthKey(currentMonthKey(), 1),
    reason: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await rescheduleAdvance(advance.id, {
      numberOfInstallments: Number(form.numberOfInstallments),
      repaymentStartMonth: form.repaymentStartMonth,
      reason: form.reason,
    })
    onSaved()
  })
  return (
    <Modal open onClose={onClose} title="Change repayment plan" eyebrow={advance.reference}>
      <form className="simple-form" onSubmit={submit} noValidate>
        <p className="muted">
          Instalments already deducted stay as they are; the remaining <Money value={advance.remainingAmount} currency={advance.currency} /> is spread again.
        </p>
        <div className="two-col">
          <FormField label="Remaining instalments" error={error?.fieldError?.('numberOfInstallments')}>
            <input type="number" min="1" max="60" value={form.numberOfInstallments} onChange={(e) => set('numberOfInstallments', e.target.value)} />
          </FormField>
          <FormField label="Starting" error={error?.fieldError?.('repaymentStartMonth')}>
            <input type="month" value={form.repaymentStartMonth} onChange={(e) => set('repaymentStartMonth', e.target.value)} />
          </FormField>
        </div>
        <FormField label="Reason" error={error?.fieldError?.('reason')}>
          <input value={form.reason} onChange={(e) => set('reason', e.target.value)} required />
        </FormField>
        <FormError error={error} />
        <div className="form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving && <Spinner size={15} />} Save plan
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** An employee requesting for themselves, or HR filing on someone's behalf. */
export function AdvanceRequestForm({ employeePicker, onCancel, onSaved, currency = 'AED' }) {
  const [form, setForm] = useState({ employeeId: '', amount: '', requestedInstallments: '3', reason: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const advance = await requestAdvance({
      employeeId: form.employeeId || undefined,
      amount: Number(form.amount),
      requestedInstallments: Number(form.requestedInstallments) || undefined,
      reason: form.reason,
    })
    onSaved(advance)
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      {employeePicker?.(form.employeeId, (value) => set('employeeId', value), error?.fieldError?.('employeeId'))}
      <div className="two-col">
        <FormField label={`Amount (${currency})`} error={error?.fieldError?.('amount')}>
          <input type="number" min="1" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="3000" required />
        </FormField>
        <FormField label="Repay over (months)" error={error?.fieldError?.('requestedInstallments')}>
          <input type="number" min="1" max="60" value={form.requestedInstallments} onChange={(e) => set('requestedInstallments', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Reason" error={error?.fieldError?.('reason')}>
        <textarea rows="3" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="What the advance is for" required />
      </FormField>
      <p className="small muted">HR decides the final amount and plan. Instalments are deducted from your salary through payroll.</p>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Submit request
        </button>
      </div>
    </form>
  )
}
