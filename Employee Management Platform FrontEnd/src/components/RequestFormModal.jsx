import { useEffect, useState } from 'react'
import { ArrowUpRight, CalendarDays, FileText, Info, Plane, UserRound } from 'lucide-react'
import { FormError, FormField, Modal, Spinner } from './ui.jsx'
import { EmployeePicker } from './EmployeePicker.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate, todayIso } from '../lib/format.js'
import { DOCUMENT_REQUEST_TYPES } from '../data.js'
import {
  approveRequest,
  fetchEmployeeBalances,
  fetchLeaveTypes,
  previewLeave,
  submitDocumentRequest,
  submitLeaveRequest,
  submitProfileChangeRequest,
} from '../api/endpoints.js'

const PROFILE_FIELDS = [
  { key: 'phone', label: 'Phone number' },
  { key: 'personalEmail', label: 'Personal email', type: 'email' },
  { key: 'addressLine', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'emergencyContactName', label: 'Emergency contact name' },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone' },
  { key: 'emergencyContactRelation', label: 'Emergency contact relation' },
]

/**
 * The single self-service submission surface, shared by the employee home and
 * requests pages. `type` is 'Leave' | 'Document' | 'Profile' - null closes it.
 */
export default function RequestFormModal({ type, profile, balances = [], onClose, onSubmitted, onToast }) {
  if (!type) return null

  const title =
    type === 'Leave' ? 'Request time away' : type === 'Document' ? 'Request an HR document' : 'Update my details'

  return (
    <Modal open={Boolean(type)} onClose={onClose} title={title} eyebrow="Employee self-service">
      {type === 'Leave' && (
        <LeaveForm balances={balances} onClose={onClose} onSubmitted={onSubmitted} onToast={onToast} />
      )}
      {type === 'Document' && <DocumentForm onClose={onClose} onSubmitted={onSubmitted} onToast={onToast} />}
      {type === 'Profile' && (
        <ProfileChangeForm profile={profile} onClose={onClose} onSubmitted={onSubmitted} onToast={onToast} />
      )}
    </Modal>
  )
}

/**
 * HR records leave for someone else: a request that arrived by email or in
 * person, or an absence that has already started. It is filed on the
 * employee's behalf, so their notice period does not apply and past dates are
 * allowed, and HR can approve it in the same step. Nobody records their own
 * leave this way - that stays self-service, where the approval rules apply.
 */
export function RecordLeaveModal({ open, employee, session, onClose, onRecorded, onToast }) {
  const [employeeId, setEmployeeId] = useState(employee?.id ?? '')
  useEffect(() => {
    if (open) setEmployeeId(employee?.id ?? '')
  }, [open, employee?.id])

  if (!open) return null
  const isSelf = Boolean(employeeId) && employeeId === session?.employee?.id

  return (
    <Modal open={open} onClose={onClose} title="Record leave" eyebrow={employee?.fullName ?? 'On behalf of an employee'}>
      {!employee && <EmployeePicker value={employeeId} onChange={setEmployeeId} />}
      {isSelf && <p className="muted">Your own leave goes through My requests, so that someone else decides it.</p>}
      {employeeId && !isSelf && (
        <LeaveForm key={employeeId} employeeId={employeeId} onClose={onClose} onSubmitted={onRecorded} onToast={onToast} />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------

function LeaveForm({ balances = [], employeeId, onClose, onSubmitted, onToast }) {
  const recording = Boolean(employeeId)
  const leaveTypes = useResource(() => fetchLeaveTypes(), [])
  const theirBalances = useResource(() => (recording ? fetchEmployeeBalances(employeeId) : Promise.resolve([])), [employeeId])
  const shownBalances = recording ? (theirBalances.data ?? []) : balances
  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    halfDayStart: false,
    halfDayEnd: false,
    reason: '',
    handoverNotes: '',
    approveNow: true,
  })
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  // Default to annual leave, the type people mean most of the time.
  useEffect(() => {
    if (!form.leaveTypeId && leaveTypes.data?.length) {
      const annual = leaveTypes.data.find((item) => item.code === 'ANNUAL') ?? leaveTypes.data[0]
      set('leaveTypeId', annual.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveTypes.data])

  /**
   * Asks the API how many days the range actually costs, using the employee's
   * own entity working week and holiday calendar. The number shown here is the
   * number that will be deducted - the frontend never guesses it.
   */
  useEffect(() => {
    if (!form.startDate || !form.endDate || form.endDate < form.startDate) {
      setPreview(null)
      return undefined
    }

    let cancelled = false
    setPreviewing(true)

    const timeout = window.setTimeout(async () => {
      try {
        const result = await previewLeave({
          startDate: form.startDate,
          endDate: form.endDate,
          halfDayStart: form.halfDayStart,
          halfDayEnd: form.halfDayEnd,
          employeeId: employeeId || undefined,
        })
        if (!cancelled) setPreview(result)
      } catch {
        if (!cancelled) setPreview(null)
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [form.startDate, form.endDate, form.halfDayStart, form.halfDayEnd, employeeId])

  const selectedBalance = shownBalances.find((balance) => balance.leaveTypeId === form.leaveTypeId)
  const selectedType = leaveTypes.data?.find((item) => item.id === form.leaveTypeId)

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    let request
    try {
      request = await submitLeaveRequest({
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        halfDayStart: form.halfDayStart,
        halfDayEnd: form.halfDayEnd,
        reason: form.reason,
        handoverNotes: form.handoverNotes || undefined,
        employeeId: employeeId || undefined,
      })
    } catch (caught) {
      setError(caught)
      setSaving(false)
      return
    }

    const who = request.employee?.fullName ?? 'the employee'
    if (!recording) {
      onToast(`${request.reference} submitted — ${request.days} day(s) held pending approval.`)
    } else if (!form.approveNow) {
      onToast(`${request.reference} recorded for ${who} — ${request.days} day(s) waiting for a decision.`)
    } else {
      // Recorded either way; if the approval is refused the request simply
      // stays pending, where it can be decided from Requests.
      try {
        await approveRequest(request.id, 'Recorded and approved by HR')
        onToast(`${request.reference} approved — ${request.days} day(s) of leave for ${who}.`)
      } catch (caught) {
        onToast(`${request.reference} recorded but not approved: ${caught.message}`, 'error')
      }
    }
    onSubmitted(request)
  }

  return (
    <form className="request-form" onSubmit={submit} noValidate>
      <div className="leave-balance-inline">
        <span>
          <Plane size={20} />
        </span>
        <div>
          <small>Available balance</small>
          <strong>{selectedBalance ? `${selectedBalance.available} days` : '—'}</strong>
        </div>
        {preview && (
          <p>
            This request uses <b>{preview.workingDays}</b> working day{preview.workingDays === 1 ? '' : 's'}
          </p>
        )}
        {previewing && !preview && <p>Calculating…</p>}
      </div>

      <FormField label="Leave type" error={error?.fieldError?.('leaveTypeId')}>
        <select value={form.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)} required>
          {(leaveTypes.data ?? []).map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
              {item.isPaid ? '' : ' (unpaid)'}
            </option>
          ))}
        </select>
      </FormField>

      <div className="two-col">
        {/* HR may record an absence that has already started; employees plan ahead. */}
        <FormField label="Start date" error={error?.fieldError?.('startDate')}>
          <input type="date" min={recording ? undefined : todayIso()} value={form.startDate} onChange={(e) => set('startDate', e.target.value)} required />
        </FormField>
        <FormField label="End date" error={error?.fieldError?.('endDate')}>
          <input
            type="date"
            min={form.startDate || (recording ? undefined : todayIso())}
            value={form.endDate}
            onChange={(e) => set('endDate', e.target.value)}
            required
          />
        </FormField>
      </div>

      {selectedType?.allowsHalfDay && (
        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={form.halfDayStart} onChange={(e) => set('halfDayStart', e.target.checked)} />
            <span>First day is a half day</span>
          </label>
          <label>
            <input type="checkbox" checked={form.halfDayEnd} onChange={(e) => set('halfDayEnd', e.target.checked)} />
            <span>Last day is a half day</span>
          </label>
        </div>
      )}

      {/* Showing which holidays were skipped is what makes the entity calendar visible to the employee. */}
      {preview?.holidaysInRange?.length > 0 && (
        <div className="preview-note">
          <Info size={16} />
          <div>
            <strong>{recording ? 'Not counted against their balance' : 'Not counted against your balance'}</strong>
            <p>
              {preview.holidaysInRange.map((holiday) => `${holiday.name} (${formatDate(holiday.date, { year: undefined })})`).join(', ')}
            </p>
          </div>
        </div>
      )}

      <FormField label="Reason" error={error?.fieldError?.('reason')}>
        <textarea rows="2" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Family holiday" required />
      </FormField>

      <FormField label="Handover notes" hint={recording ? 'Optional — who is covering while they are away' : 'Optional — who is covering while you are away'}>
        <textarea rows="2" value={form.handoverNotes} onChange={(e) => set('handoverNotes', e.target.value)} />
      </FormField>

      {recording && (
        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={form.approveNow} onChange={(e) => set('approveNow', e.target.checked)} />
            <span>Approve it now — untick to leave the decision to their manager</span>
          </label>
        </div>
      )}

      <FormError error={error} />

      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? <Spinner size={16} /> : <ArrowUpRight size={17} />}{' '}
          {!recording ? 'Submit request' : form.approveNow ? 'Record and approve' : 'Record leave'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

function DocumentForm({ onClose, onSubmitted, onToast }) {
  const [form, setForm] = useState({
    documentType: 'EMPLOYMENT_CERTIFICATE',
    purpose: '',
    addressedTo: '',
    language: 'EN',
    includeSalary: false,
  })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  // A salary certificate states the salary by definition, so the choice is not
  // offered for that type.
  const salaryIsImplied = form.documentType === 'SALARY_CERTIFICATE'

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const request = await submitDocumentRequest({
        documentType: form.documentType,
        purpose: form.purpose,
        addressedTo: form.addressedTo || undefined,
        language: form.language,
        includeSalary: salaryIsImplied ? true : form.includeSalary,
      })
      onToast(`${request.reference} submitted. HR will prepare your document.`)
      onSubmitted()
    } catch (caught) {
      setError(caught)
      setSaving(false)
    }
  }

  return (
    <form className="request-form" onSubmit={submit} noValidate>
      <div className="document-note">
        <FileText size={21} />
        <div>
          <strong>Usually ready within 2 business days</strong>
          <p>You will see the decision and the issued letter in your request history.</p>
        </div>
      </div>

      <FormField label="Document type" error={error?.fieldError?.('documentType')}>
        <select value={form.documentType} onChange={(e) => set('documentType', e.target.value)}>
          {DOCUMENT_REQUEST_TYPES.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>

      <div className="two-col">
        <FormField label="Language">
          <select value={form.language} onChange={(e) => set('language', e.target.value)}>
            <option value="EN">English</option>
            <option value="AR">Arabic</option>
          </select>
        </FormField>
        <FormField label="Addressed to" hint="Optional">
          <input value={form.addressedTo} onChange={(e) => set('addressedTo', e.target.value)} placeholder="Bank or embassy name" />
        </FormField>
      </div>

      <FormField label="Purpose" error={error?.fieldError?.('purpose')}>
        <textarea
          rows="3"
          value={form.purpose}
          onChange={(e) => set('purpose', e.target.value)}
          placeholder="Visa application, bank account opening…"
          required
        />
      </FormField>

      {!salaryIsImplied && (
        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={form.includeSalary} onChange={(e) => set('includeSalary', e.target.checked)} />
            <span>Include my salary in the letter</span>
          </label>
        </div>
      )}
      {salaryIsImplied && (
        <p className="form-hint">A salary certificate always states your salary.</p>
      )}

      <FormError error={error} />

      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? <Spinner size={16} /> : <ArrowUpRight size={17} />} Submit request
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

/**
 * Employees propose changes to their own contact details rather than editing
 * them directly. Job title, salary, entity and manager are not offered here and
 * are not accepted by the API either.
 */
function ProfileChangeForm({ profile, onClose, onSubmitted, onToast }) {
  const [form, setForm] = useState(() => ({
    phone: profile?.phone ?? '',
    personalEmail: profile?.personalEmail ?? '',
    addressLine: profile?.addressLine ?? '',
    city: profile?.city ?? '',
    country: profile?.country ?? '',
    emergencyContactName: profile?.emergencyContactName ?? '',
    emergencyContactPhone: profile?.emergencyContactPhone ?? '',
    emergencyContactRelation: profile?.emergencyContactRelation ?? '',
  }))
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  const current = {
    phone: profile?.phone ?? '',
    personalEmail: profile?.personalEmail ?? '',
    addressLine: profile?.addressLine ?? '',
    city: profile?.city ?? '',
    country: profile?.country ?? '',
    emergencyContactName: profile?.emergencyContactName ?? '',
    emergencyContactPhone: profile?.emergencyContactPhone ?? '',
    emergencyContactRelation: profile?.emergencyContactRelation ?? '',
  }

  // Only genuinely changed fields are sent, so the approver reviews a short list.
  const changed = PROFILE_FIELDS.filter((field) => (form[field.key] ?? '') !== (current[field.key] ?? ''))

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = Object.fromEntries(
        changed.filter((field) => form[field.key]).map((field) => [field.key, form[field.key]]),
      )
      const request = await submitProfileChangeRequest(payload)
      onToast(`${request.reference} submitted for approval.`)
      onSubmitted()
    } catch (caught) {
      setError(caught)
      setSaving(false)
    }
  }

  return (
    <form className="request-form" onSubmit={submit} noValidate>
      <div className="document-note">
        <UserRound size={21} />
        <div>
          <strong>Changes are reviewed before they are applied</strong>
          <p>Your record is used for payroll and official documents, so People Operations approves updates.</p>
        </div>
      </div>

      <div className="two-col">
        {PROFILE_FIELDS.map((field) => (
          <FormField key={field.key} label={field.label} error={error?.fieldError?.(`changes.${field.key}`)}>
            <input
              type={field.type ?? 'text'}
              value={form[field.key]}
              onChange={(event) => set(field.key, event.target.value)}
            />
          </FormField>
        ))}
      </div>

      {changed.length > 0 && (
        <div className="preview-note">
          <CalendarDays size={16} />
          <div>
            <strong>
              {changed.length} change{changed.length === 1 ? '' : 's'} will be submitted
            </strong>
            <p>{changed.map((field) => field.label).join(', ')}</p>
          </div>
        </div>
      )}

      <FormError error={error} />

      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving || !changed.length}>
          {saving ? <Spinner size={16} /> : <ArrowUpRight size={17} />} Submit for approval
        </button>
      </div>
    </form>
  )
}
