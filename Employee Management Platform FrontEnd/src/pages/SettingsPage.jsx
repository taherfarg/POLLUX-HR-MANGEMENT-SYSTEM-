import { useEffect, useMemo, useState } from 'react'
import { ImageUp, LockKeyhole, Pencil, Plus, Save, Trash2 } from 'lucide-react'
import {
  Async,
  DataTable,
  EmptyState,
  FormError,
  FormField,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
  useSubmit,
} from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { createLeaveType, fetchCompanySettings, fetchLeaveTypes, updateCompanySettings, updateLeaveType } from '../api/endpoints.js'
import { TIMEZONE_OPTIONS, WEEKDAY_NAMES } from '../data.js'

const PAY_BASE_OPTIONS = [
  { value: 'BASIC', label: 'Basic salary' },
  { value: 'GROSS', label: 'Gross salary (basic + fixed allowances)' },
]

/**
 * Every policy value the platform uses, in one place. Field keys are the API's
 * keys inside each section, so a validation message from the server lands on
 * the right input ("attendance.lateGraceMinutes").
 */
const SECTIONS = [
  {
    id: 'company',
    label: 'Company',
    description: 'Identity printed on payslips and letters, and the working week everything else is measured against.',
    fields: [
      { key: 'displayName', label: 'Display name', hint: 'The short name used across the app' },
      { key: 'legalName', label: 'Legal name', hint: 'As on the trade licence - printed on payslips' },
      { key: 'registrationNumber', label: 'Trade licence / registration no.' },
      { key: 'addressLine', label: 'Address', optional: true },
      { key: 'city', label: 'City' },
      { key: 'countryName', label: 'Country' },
      { key: 'countryCode', label: 'Country code', hint: 'Two letters, e.g. AE', maxLength: 2, upper: true },
      { key: 'currency', label: 'Currency', hint: 'Changing it does not convert amounts already recorded', maxLength: 3, upper: true },
      { key: 'timezone', label: 'Company timezone', type: 'timezone' },
      { key: 'weeklyHours', label: 'Weekly hours', type: 'number', min: 1, max: 80, step: 0.5 },
      { key: 'probationMonths', label: 'Probation', type: 'number', min: 0, max: 24, suffix: 'months' },
      { key: 'noticePeriodDays', label: 'Notice period', type: 'number', min: 0, max: 365, suffix: 'days' },
      { key: 'employeeNumberPrefix', label: 'Employee number prefix', hint: 'New employees are numbered PREFIX-0001', optional: true, nullable: true, maxLength: 6, upper: true },
      { key: 'workWeek', label: 'Working days', type: 'weekdays', wide: true },
      { key: 'logoUrl', label: 'Logo', type: 'logo', nullable: true, wide: true },
    ],
  },
  {
    id: 'attendance',
    label: 'Attendance',
    description: 'How check-ins become Present, Late, Partial, Absent or Missing check-out. Times are always evaluated in the employee’s own timezone.',
    fields: [
      {
        key: 'attendanceStartDate',
        label: 'Attendance tracked from',
        type: 'date',
        nullable: true,
        optional: true,
        hint: 'The go-live date. No day before it is ever marked absent.',
      },
      { key: 'lateGraceMinutes', label: 'Late grace', type: 'number', min: 0, max: 240, suffix: 'minutes', hint: 'Checking in within this after the start is not late' },
      { key: 'earlyLeaveGraceMinutes', label: 'Early-leave grace', type: 'number', min: 0, max: 240, suffix: 'minutes' },
      { key: 'partialDayThresholdPercent', label: 'Partial day below', type: 'number', min: 0, max: 100, suffix: '% of the shift' },
      { key: 'missingCheckoutAfterMinutes', label: 'Missing check-out after', type: 'number', min: 15, max: 1440, suffix: 'minutes past shift end' },
    ],
  },
  {
    id: 'overtime',
    label: 'Overtime',
    description: 'Overtime is paid only once approved. Rates multiply the hourly rate derived from the chosen salary base.',
    fields: [
      { key: 'overtimeEnabled', label: 'Track overtime', type: 'toggle' },
      { key: 'overtimeRequiresApproval', label: 'Overtime needs approval before it is paid', type: 'toggle' },
      { key: 'countEarlyArrivalAsOvertime', label: 'Count early arrival as overtime', type: 'toggle' },
      { key: 'minOvertimeMinutes', label: 'Minimum overtime', type: 'number', min: 0, max: 1440, suffix: 'minutes', hint: 'Shorter stays are ignored' },
      { key: 'overtimeRateMultiplier', label: 'Working-day rate', type: 'number', min: 1, max: 3, step: 0.05, suffix: '× hourly rate' },
      { key: 'restDayOvertimeMultiplier', label: 'Rest day / holiday rate', type: 'number', min: 1, max: 3, step: 0.05, suffix: '× hourly rate' },
      { key: 'overtimeBase', label: 'Hourly rate based on', type: 'select', options: PAY_BASE_OPTIONS },
      { key: 'standardDailyHours', label: 'Standard day', type: 'number', min: 1, max: 24, step: 0.5, suffix: 'hours' },
    ],
  },
  {
    id: 'payroll',
    label: 'Payroll',
    description: 'How a month’s salary is prorated and which deductions payroll applies. Amounts are always calculated on the server with exact decimals.',
    fields: [
      { key: 'payrollDay', label: 'Pay day', type: 'number', min: 1, max: 31, suffix: 'of the month' },
      {
        key: 'salaryDayBasis',
        label: 'Daily rate divisor',
        type: 'select',
        options: [
          { value: 'FIXED_30', label: 'Fixed 30 days' },
          { value: 'CALENDAR_DAYS', label: 'Calendar days in the month' },
          { value: 'WORKING_DAYS', label: 'Working days in the month' },
        ],
      },
      { key: 'deductionBase', label: 'Absence deductions based on', type: 'select', options: PAY_BASE_OPTIONS },
      { key: 'absenceDeductionEnabled', label: 'Deduct unexcused absence', type: 'toggle' },
      { key: 'unpaidLeaveDeductionEnabled', label: 'Deduct approved unpaid leave', type: 'toggle' },
      { key: 'lateDeductionEnabled', label: 'Deduct late minutes', type: 'toggle' },
      { key: 'payrollRequiresSeparateApprover', label: 'Four-eyes: whoever calculates a payroll or enters a bonus cannot approve it', type: 'toggle' },
    ],
  },
  {
    id: 'advances',
    label: 'Salary advances',
    description: 'Limits checked when an advance is requested and again when it is approved.',
    fields: [
      { key: 'maxAdvanceAmount', label: 'Largest advance', type: 'number', min: 0, step: 0.01, nullable: true, optional: true, hint: 'Empty means no company limit', currency: true },
      { key: 'maxAdvanceInstallments', label: 'Most instalments', type: 'number', min: 1, max: 60, suffix: 'months' },
      { key: 'allowConcurrentAdvances', label: 'Allow a second advance while one is being repaid', type: 'toggle' },
    ],
  },
  {
    id: 'defaults',
    label: 'Defaults',
    description: 'Used for employees who have no work schedule or holiday calendar of their own.',
    fields: [
      { key: 'defaultWorkScheduleId', label: 'Default work schedule', type: 'schedule', nullable: true },
      { key: 'defaultHolidayCalendarId', label: 'Default holiday calendar', type: 'calendar', nullable: true },
    ],
  },
]

const NAV = [...SECTIONS.map(({ id, label }) => ({ id, label })), { id: 'leave-types', label: 'Leave types' }]

/**
 * Company settings. Everything the platform used to hard-code - grace minutes,
 * overtime rates, payroll proration, advance limits - lives here, in the
 * database, with each save recorded in the audit trail. Only an administrator
 * changes it; HR reads it (and manages leave types).
 */
export default function SettingsPage({ session, onToast }) {
  const settings = useResource(() => fetchCompanySettings(), [])
  const { reload: reloadCompany } = useCompany()
  const [active, setActive] = useState('company')
  const section = SECTIONS.find((entry) => entry.id === active)

  return (
    <div className="page">
      <PageHeader title="Company settings" description={settings.data?.company?.legalName ?? 'Company policy'} />
      {!session.isAdmin && (
        <div className="notice">
          <LockKeyhole size={16} />
          <span>Only an administrator can change company settings. You can review them here and manage leave types.</span>
        </div>
      )}
      <div className="settings-layout">
        <nav className="panel settings-nav" aria-label="Settings sections">
          {NAV.map((entry) => (
            <button key={entry.id} type="button" className={entry.id === active ? 'active' : ''} aria-current={entry.id === active ? 'page' : undefined} onClick={() => setActive(entry.id)}>
              {entry.label}
            </button>
          ))}
        </nav>
        <Async loading={settings.loading} error={settings.error} onRetry={settings.reload} rows={6}>
          {section && settings.data && (
            <SectionForm
              key={section.id}
              section={section}
              values={settings.data[section.id] ?? {}}
              readOnly={!session.isAdmin}
              onSaved={(after) => {
                settings.setData(after)
                reloadCompany()
                onToast(`${section.label} settings saved.`)
              }}
            />
          )}
          {active === 'leave-types' && <LeaveTypesPanel onToast={onToast} />}
        </Async>
      </div>
    </div>
  )
}

const toFormValue = (field, value) => {
  if (field.type === 'toggle') return Boolean(value)
  if (field.type === 'weekdays') return Array.isArray(value) ? [...value].sort((a, b) => a - b) : []
  return value === null || value === undefined ? '' : String(value)
}

/** Form value -> API value, or undefined when the field should not be sent. */
const toApiValue = (field, value) => {
  if (field.type === 'toggle' || field.type === 'weekdays') return value
  const text = String(value).trim()
  if (text === '') return field.nullable ? null : undefined
  if (field.type === 'number') return Number(text)
  return field.upper ? text.toUpperCase() : text
}

function SectionForm({ section, values, readOnly, onSaved }) {
  const { schedules, calendars, currency } = useCompany()
  const initial = useMemo(() => Object.fromEntries(section.fields.map((field) => [field.key, toFormValue(field, values[field.key])])), [section, values])
  const [form, setForm] = useState(initial)
  useEffect(() => setForm(initial), [initial])
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  const changed = section.fields.filter((field) => JSON.stringify(form[field.key]) !== JSON.stringify(initial[field.key]))

  const { submit, saving, error } = useSubmit(async () => {
    const payload = {}
    for (const field of changed) {
      const value = toApiValue(field, form[field.key])
      if (value !== undefined) payload[field.key] = value
    }
    if (Object.keys(payload).length === 0) return
    onSaved(await updateCompanySettings({ [section.id]: payload }))
  })

  const fieldError = (key) => error?.fieldError?.(`${section.id}.${key}`)

  return (
    <Panel title={section.label} description={section.description}>
      <form className="stack-form" onSubmit={submit} noValidate>
        <fieldset className="two-col plain-fieldset" disabled={readOnly || saving}>
          {section.fields.map((field) => (
            <SettingField
              key={field.key}
              field={field}
              value={form[field.key]}
              onChange={(value) => set(field.key, value)}
              error={fieldError(field.key)}
              schedules={schedules}
              calendars={calendars}
              currency={currency}
            />
          ))}
        </fieldset>
        <FormError error={error && !section.fields.some((field) => fieldError(field.key)) ? error : null} />
        {!readOnly && (
          <div className="form-actions">
            <button type="button" className="button button-ghost" onClick={() => setForm(initial)} disabled={saving || changed.length === 0}>
              Discard changes
            </button>
            <button type="submit" className="button button-primary" disabled={saving || changed.length === 0}>
              {saving ? <Spinner size={15} /> : <Save size={15} />} Save {section.label.toLowerCase()}
            </button>
          </div>
        )}
      </form>
    </Panel>
  )
}

function SettingField({ field, value, onChange, error, schedules, calendars, currency }) {
  const className = field.wide ? 'span-2' : ''
  const hint = field.suffix ? [field.suffix, field.hint].filter(Boolean).join(' · ') : field.hint

  if (field.type === 'toggle') {
    return (
      <label className={`check span-2 ${error ? 'field-error' : ''}`}>
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        {field.label}
        {error && <em className="small">{error}</em>}
      </label>
    )
  }

  if (field.type === 'weekdays') {
    const toggle = (day) => onChange(value.includes(day) ? value.filter((entry) => entry !== day) : [...value, day].sort((a, b) => a - b))
    return (
      <FormField label={field.label} error={error} hint="The UAE week is Monday to Friday" className={className}>
        <div className="checkbox-row" role="group" aria-label={field.label}>
          {WEEKDAY_NAMES.map((name, day) => (
            <label key={name} className="check">
              <input type="checkbox" checked={value.includes(day)} onChange={() => toggle(day)} />
              {name.slice(0, 3)}
            </label>
          ))}
        </div>
      </FormField>
    )
  }

  if (field.type === 'logo') return <LogoField field={field} value={value} onChange={onChange} error={error} />

  let control
  if (field.type === 'select' || field.type === 'schedule' || field.type === 'calendar' || field.type === 'timezone') {
    const options =
      field.type === 'schedule'
        ? [{ value: '', label: 'None' }, ...schedules.map((item) => ({ value: item.id, label: `${item.name} (${item.code})` }))]
        : field.type === 'calendar'
          ? [{ value: '', label: 'None' }, ...calendars.map((item) => ({ value: item.id, label: `${item.name} (${item.code})` }))]
          : field.type === 'timezone'
            ? [...new Set([value, ...TIMEZONE_OPTIONS].filter(Boolean))].map((zone) => ({ value: zone, label: zone }))
            : field.options
    control = (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  } else if (field.type === 'number') {
    control = <input type="number" inputMode="decimal" value={value} min={field.min} max={field.max} step={field.step ?? 1} onChange={(event) => onChange(event.target.value)} />
  } else if (field.type === 'date') {
    control = <input type="date" value={value} onChange={(event) => onChange(event.target.value)} />
  } else {
    control = <input value={value} maxLength={field.maxLength} onChange={(event) => onChange(field.upper ? event.target.value.toUpperCase() : event.target.value)} />
  }

  const label = field.currency && currency ? `${field.label} (${currency})` : field.label
  return (
    <FormField
      label={
        field.optional ? (
          <span>
            {label} <small>Optional</small>
          </span>
        ) : (
          label
        )
      }
      error={error}
      hint={hint}
      className={className}
    >
      {control}
    </FormField>
  )
}

const LOGO_LIMIT_BYTES = 300 * 1024

function LogoField({ field, value, onChange, error }) {
  const [localError, setLocalError] = useState(null)
  const isInline = value.startsWith('data:')

  const upload = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      setLocalError('Use a PNG, JPEG, WebP or SVG image.')
      return
    }
    if (file.size > LOGO_LIMIT_BYTES) {
      setLocalError('Use an image under 300 KB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setLocalError(null)
      onChange(String(reader.result))
    }
    reader.readAsDataURL(file)
  }

  return (
    <FormField label={field.label} error={error ?? localError} hint="An https:// link or an uploaded PNG, JPEG, WebP or SVG under 300 KB" className="span-2">
      <div className="logo-field">
        <span className="logo-preview">{value ? <img src={value} alt="Company logo preview" /> : <small className="muted">No logo</small>}</span>
        <input
          aria-label="Logo URL"
          placeholder="https://…"
          value={isInline ? 'Uploaded image' : value}
          readOnly={isInline}
          onChange={(event) => onChange(event.target.value)}
        />
        <label className="button button-secondary button-sm">
          <ImageUp size={14} /> Upload
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={upload} hidden />
        </label>
        {value && (
          <button type="button" className="button button-ghost button-sm" onClick={() => onChange('')}>
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>
    </FormField>
  )
}

// --- Leave types ---------------------------------------------------------------------------

function LeaveTypesPanel({ onToast }) {
  const types = useResource(() => fetchLeaveTypes({ includeInactive: true }), [])
  const [editing, setEditing] = useState(null)

  return (
    <Panel
      title="Leave types"
      description="Entitlements used when yearly balances are generated. Changing an entitlement does not rewrite balances already issued - adjust those under Leave balances."
      actions={
        <button className="button button-primary" onClick={() => setEditing({})}>
          <Plus size={16} /> Add leave type
        </button>
      }
      flush
    >
      <Async loading={types.loading} error={types.error} onRetry={types.reload} rows={4}>
        <DataTable
          caption="Leave types"
          columns={[
            {
              key: 'name',
              label: 'Leave type',
              primary: true,
              render: (row) => (
                <div>
                  <strong>
                    <i className="chip-dot" style={{ background: row.colorHex }} /> {row.name}
                  </strong>
                  <small className="mono">{row.code}</small>
                </div>
              ),
            },
            { key: 'annualEntitlementDays', label: 'Days a year', className: 'num', render: (row) => row.annualEntitlementDays },
            { key: 'carryOverMaxDays', label: 'Carry over up to', className: 'num', render: (row) => row.carryOverMaxDays },
            { key: 'isPaid', label: 'Pay', render: (row) => (row.isPaid ? 'Paid' : 'Unpaid') },
            { key: 'rules', label: 'Rules', render: (row) => leaveRules(row) },
            { key: 'isActive', label: 'Status', render: (row) => <StatusPill status={row.isActive ? 'ACTIVE' : 'INACTIVE'} label={row.isActive ? 'Active' : 'Inactive'} /> },
            {
              key: 'actions',
              label: '',
              className: 'actions',
              render: (row) => (
                <button className="button button-ghost button-sm" onClick={() => setEditing(row)}>
                  <Pencil size={14} /> Edit
                </button>
              ),
            },
          ]}
          rows={types.data ?? []}
          empty={<EmptyState title="No leave types yet" />}
        />
      </Async>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : 'Add a leave type'}>
        {editing && (
          <LeaveTypeForm
            type={editing}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null)
              types.reload()
              onToast(`${saved.name} saved.`)
            }}
          />
        )}
      </Modal>
    </Panel>
  )
}

function leaveRules(type) {
  const rules = []
  if (type.allowsHalfDay) rules.push('half days')
  if (type.requiresAttachment) rules.push('attachment')
  if (type.minNoticeDays) rules.push(`${type.minNoticeDays} days notice`)
  if (type.maxConsecutiveDays) rules.push(`max ${type.maxConsecutiveDays} in a row`)
  if (type.restrictedToGender) rules.push(type.restrictedToGender === 'FEMALE' ? 'women only' : type.restrictedToGender === 'MALE' ? 'men only' : 'restricted')
  return rules.length ? rules.join(' · ') : '—'
}

function LeaveTypeForm({ type, onCancel, onSaved }) {
  const isNew = !type.id
  const [form, setForm] = useState({
    code: type.code ?? '',
    name: type.name ?? '',
    description: type.description ?? '',
    colorHex: type.colorHex ?? '#2563eb',
    annualEntitlementDays: String(type.annualEntitlementDays ?? 0),
    carryOverMaxDays: String(type.carryOverMaxDays ?? 0),
    minNoticeDays: String(type.minNoticeDays ?? 0),
    maxConsecutiveDays: type.maxConsecutiveDays ? String(type.maxConsecutiveDays) : '',
    isPaid: type.isPaid ?? true,
    allowsHalfDay: type.allowsHalfDay ?? true,
    requiresAttachment: type.requiresAttachment ?? false,
    isActive: type.isActive ?? true,
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  const { submit, saving, error } = useSubmit(async () => {
    const payload = {
      name: form.name,
      description: form.description,
      colorHex: form.colorHex,
      annualEntitlementDays: form.annualEntitlementDays,
      carryOverMaxDays: form.carryOverMaxDays,
      minNoticeDays: form.minNoticeDays,
      maxConsecutiveDays: form.maxConsecutiveDays || undefined,
      isPaid: form.isPaid,
      allowsHalfDay: form.allowsHalfDay,
      requiresAttachment: form.requiresAttachment,
      isActive: form.isActive,
    }
    onSaved(isNew ? await createLeaveType({ ...payload, code: form.code }) : await updateLeaveType(type.id, payload))
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </FormField>
        <FormField label="Code" hint={isNew ? 'Short and permanent, e.g. ANNUAL' : 'Cannot be changed'} error={error?.fieldError?.('code')}>
          <input className="mono" value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} disabled={!isNew} maxLength={30} />
        </FormField>
        <FormField label="Days a year" error={error?.fieldError?.('annualEntitlementDays')}>
          <input type="number" min="0" max="365" step="0.5" value={form.annualEntitlementDays} onChange={(e) => set('annualEntitlementDays', e.target.value)} />
        </FormField>
        <FormField label="Carry over up to" hint="Unused days moved into next year" error={error?.fieldError?.('carryOverMaxDays')}>
          <input type="number" min="0" max="90" step="0.5" value={form.carryOverMaxDays} onChange={(e) => set('carryOverMaxDays', e.target.value)} />
        </FormField>
        <FormField label="Notice required" hint="days" error={error?.fieldError?.('minNoticeDays')}>
          <input type="number" min="0" max="180" value={form.minNoticeDays} onChange={(e) => set('minNoticeDays', e.target.value)} />
        </FormField>
        <FormField label="Most days in a row" hint="Empty: no limit" error={error?.fieldError?.('maxConsecutiveDays')}>
          <input type="number" min="1" max="365" value={form.maxConsecutiveDays} onChange={(e) => set('maxConsecutiveDays', e.target.value)} />
        </FormField>
        <FormField label="Colour" error={error?.fieldError?.('colorHex')}>
          <input type="color" value={form.colorHex} onChange={(e) => set('colorHex', e.target.value)} />
        </FormField>
        <FormField label="Description" error={error?.fieldError?.('description')}>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={300} />
        </FormField>
      </div>
      <div className="checkbox-row">
        <label className="check">
          <input type="checkbox" checked={form.isPaid} onChange={(e) => set('isPaid', e.target.checked)} /> Paid leave
        </label>
        <label className="check">
          <input type="checkbox" checked={form.allowsHalfDay} onChange={(e) => set('allowsHalfDay', e.target.checked)} /> Half days allowed
        </label>
        <label className="check">
          <input type="checkbox" checked={form.requiresAttachment} onChange={(e) => set('requiresAttachment', e.target.checked)} /> Needs an attachment
        </label>
        <label className="check">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
        </label>
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving || form.name.trim().length < 2 || (isNew && form.code.trim().length < 2)}>
          {saving && <Spinner size={15} />} {isNew ? 'Add leave type' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
