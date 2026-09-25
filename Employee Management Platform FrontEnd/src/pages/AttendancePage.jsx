import { useEffect, useState } from 'react'
import { AlarmClock, CheckCircle2, Clock, Laptop, Palmtree, Pencil, Plus, RefreshCcw, UserX } from 'lucide-react'
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
  StatCard,
  Tabs,
  useSubmit,
} from '../components/ui.jsx'
import { AttendanceStatus, ATTENDANCE_LABELS } from '../components/attendance.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { emitChange, useChangeListener } from '../lib/events.js'
import { formatDateTime, formatDay, formatMinutes, monthBounds, currentMonthKey, todayIso } from '../lib/format.js'
import {
  correctAttendanceRecord,
  createAttendanceRecord,
  fetchAttendance,
  fetchAttendanceBoard,
  fetchEmployees,
  recalculateAttendance,
} from '../api/endpoints.js'
import { WORK_MODE_OPTIONS } from '../data.js'

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  ...['PRESENT', 'LATE', 'ABSENT', 'PARTIAL', 'MISSING_CHECKOUT', 'ON_LEAVE', 'NOT_CHECKED_IN'].map((value) => ({ value, label: ATTENDANCE_LABELS[value] })),
]

/**
 * Attendance for HR (everyone) and managers (their team). Every day is
 * evaluated on the server against the person's own schedule, timezone,
 * holidays and approved leave; HR corrections are audited.
 */
export default function AttendancePage({ session, onToast }) {
  const [tab, setTab] = useState('today')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(null)
  const [recalculating, setRecalculating] = useState(false)
  const canManage = session.isManagement

  return (
    <div className="page">
      <PageHeader
        title={canManage ? 'Attendance' : 'Team attendance'}
        description="Times are shown in each person's own timezone. Late and overtime follow the company grace and overtime policy."
        actions={
          canManage && (
            <>
              <button className="button button-secondary" onClick={() => setRecalculating(true)}>
                <RefreshCcw size={15} /> Recalculate
              </button>
              <button className="button button-primary" onClick={() => setCreating({})}>
                <Plus size={16} /> Record attendance
              </button>
            </>
          )
        }
      />
      <Panel flush>
        <Tabs
          tabs={[
            { id: 'today', label: 'Today' },
            { id: 'register', label: 'Register' },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'today' ? (
          <TodayBoard canManage={canManage} onEdit={setEditing} onCreate={setCreating} />
        ) : (
          <Register canManage={canManage} onEdit={setEditing} onCreate={setCreating} />
        )}
      </Panel>

      <Modal open={Boolean(creating)} onClose={() => setCreating(null)} title="Record attendance" eyebrow="HR correction · audited">
        {creating && (
          <ManualForm
            initial={creating}
            onCancel={() => setCreating(null)}
            onSaved={() => {
              setCreating(null)
              emitChange('attendance')
              onToast('Attendance recorded.')
            }}
          />
        )}
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Correct attendance" eyebrow="HR correction · audited">
        {editing && (
          <CorrectionForm
            day={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              emitChange('attendance')
              onToast('Attendance corrected.')
            }}
          />
        )}
      </Modal>
      <Modal open={recalculating} onClose={() => setRecalculating(false)} title="Recalculate attendance" eyebrow="After a schedule or policy change">
        <RecalculateForm
          onCancel={() => setRecalculating(false)}
          onSaved={(result) => {
            setRecalculating(false)
            emitChange('attendance')
            onToast(`${result?.updated ?? 0} record(s) recalculated.`)
          }}
        />
      </Modal>
    </div>
  )
}

function useSubjectFilters() {
  const [departmentId, setDepartmentId] = useState('')
  const [workLocationId, setWorkLocationId] = useState('')
  const [workMode, setWorkMode] = useState('')
  return { departmentId, setDepartmentId, workLocationId, setWorkLocationId, workMode, setWorkMode }
}

function SubjectFilterControls({ filters }) {
  const { departments, locations } = useCompany()
  return (
    <>
      <FilterSelect
        label="Department"
        value={filters.departmentId}
        onChange={filters.setDepartmentId}
        options={[{ value: '', label: 'All departments' }, ...departments.map((item) => ({ value: item.id, label: item.name }))]}
      />
      <FilterSelect
        label="Work location"
        value={filters.workLocationId}
        onChange={filters.setWorkLocationId}
        options={[{ value: '', label: 'All locations' }, ...locations.map((item) => ({ value: item.id, label: item.name }))]}
      />
      <FilterSelect label="Work mode" value={filters.workMode} onChange={filters.setWorkMode} options={[{ value: '', label: 'Any mode' }, ...WORK_MODE_OPTIONS]} />
    </>
  )
}

const dayColumns = (canManage, onEdit, onCreate, { withDate = false } = {}) => [
  ...(withDate ? [{ key: 'date', label: 'Date', render: (row) => formatDay(row.date) }] : []),
  {
    key: 'employee',
    label: 'Employee',
    primary: true,
    render: (row) => (
      <div>
        <strong>{row.employee?.fullName}</strong>
        <small>
          {row.employee?.workLocation?.name ?? row.employee?.department?.name ?? ''} · {row.timezone}
        </small>
      </div>
    ),
  },
  { key: 'schedule', label: 'Schedule', render: (row) => (row.scheduledStartLocal ? `${row.scheduledStartLocal}–${row.scheduledEndLocal}` : row.holidayName ?? '—') },
  { key: 'checkIn', label: 'In', render: (row) => row.checkInLocal ?? '—' },
  { key: 'checkOut', label: 'Out', render: (row) => row.checkOutLocal ?? '—' },
  { key: 'worked', label: 'Worked', className: 'num', render: (row) => (row.workedMinutes ? formatMinutes(row.workedMinutes) : row.isOpen ? formatMinutes(row.elapsedMinutes) : '—') },
  { key: 'late', label: 'Late', className: 'num', render: (row) => (row.lateMinutes ? formatMinutes(row.lateMinutes) : '—') },
  { key: 'overtime', label: 'Overtime', className: 'num', render: (row) => (row.overtimeMinutes ? formatMinutes(row.overtimeMinutes) : '—') },
  { key: 'status', label: 'Status', render: (row) => <AttendanceStatus day={row} /> },
  ...(canManage
    ? [
        {
          key: 'actions',
          label: '',
          className: 'actions',
          render: (row) =>
            row.id ? (
              <button className="button button-ghost button-sm" onClick={() => onEdit(row)} aria-label={`Correct ${row.employee?.fullName} on ${row.date}`}>
                <Pencil size={14} /> Correct
              </button>
            ) : row.dayType === 'WORKING_DAY' && row.status !== 'SCHEDULED' ? (
              <button className="button button-ghost button-sm" onClick={() => onCreate({ employeeId: row.employee?.id, employeeName: row.employee?.fullName, date: row.date })}>
                <Plus size={14} /> Record
              </button>
            ) : null,
        },
      ]
    : []),
]

function TodayBoard({ canManage, onEdit, onCreate }) {
  const filters = useSubjectFilters()
  const board = useResource(
    () =>
      fetchAttendanceBoard({
        departmentId: filters.departmentId || undefined,
        workLocationId: filters.workLocationId || undefined,
        workMode: filters.workMode || undefined,
      }),
    [filters.departmentId, filters.workLocationId, filters.workMode],
  )
  useChangeListener('attendance', board.reload)
  const counts = board.data?.counts ?? {}

  return (
    <>
      <div className="toolbar">
        <SubjectFilterControls filters={filters} />
        <span className="spacer" />
        <button className="button button-secondary button-sm" onClick={board.reload}>
          <RefreshCcw size={14} /> Refresh
        </button>
      </div>
      <Async loading={board.loading} error={board.error} onRetry={board.reload} rows={6}>
        {board.data && (
          <>
            <div className="panel-body">
              <section className="stat-grid">
                <StatCard icon={CheckCircle2} tone="success" label="Present" value={counts.present} />
                <StatCard icon={AlarmClock} tone="warning" label="Late" value={counts.late} />
                <StatCard icon={Clock} tone="warning" label="Not checked in" value={counts.notCheckedIn} />
                <StatCard icon={UserX} tone="danger" label="Absent" value={counts.absent} />
                <StatCard icon={Palmtree} tone="info" label="On leave" value={counts.onLeave} />
                <StatCard icon={Laptop} tone="violet" label="Remote" value={counts.remote} />
              </section>
            </div>
            <DataTable
              caption="Today's attendance"
              columns={dayColumns(canManage, onEdit, onCreate)}
              rows={board.data.rows ?? []}
              rowKey={(row) => row.employee?.id}
              empty={<EmptyState icon={Clock} title="Nobody to show" text="Nobody matches these filters today." />}
            />
            {board.data.missingCheckouts?.length > 0 && (
              <div className="panel-body">
                <p className="eyebrow">Missing check-outs this week</p>
                <div className="list">
                  {board.data.missingCheckouts.map((entry) => (
                    <div className="list-row" key={entry.recordId}>
                      <div className="grow">
                        <strong>{entry.employee.fullName}</strong>
                        <small>
                          {formatDay(entry.date)} · in at {entry.checkInLocal} ({entry.timezone})
                        </small>
                      </div>
                      {canManage && (
                        <button
                          className="button button-secondary button-sm"
                          onClick={() => onEdit({ id: entry.recordId, date: entry.date, checkInLocal: entry.checkInLocal, timezone: entry.timezone, employee: entry.employee })}
                        >
                          Add check-out
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Async>
    </>
  )
}

function Register({ canManage, onEdit, onCreate }) {
  const filters = useSubjectFilters()
  const initial = monthBounds(currentMonthKey())
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(todayIso() < initial.to ? todayIso() : initial.to)
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const debounced = useDebouncedValue(query, 300)

  useEffect(() => setPage(1), [from, to, status, debounced, filters.departmentId, filters.workLocationId, filters.workMode])

  const register = useResource(
    () =>
      fetchAttendance({
        from,
        to,
        status: status || undefined,
        q: debounced || undefined,
        departmentId: filters.departmentId || undefined,
        workLocationId: filters.workLocationId || undefined,
        workMode: filters.workMode || undefined,
        page,
        pageSize: 50,
      }),
    [from, to, status, debounced, filters.departmentId, filters.workLocationId, filters.workMode, page],
  )
  useChangeListener('attendance', register.reload)
  const totals = register.data?.totals

  return (
    <>
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Employee name or number" label="Search attendance" />
        <label className="filter-label">
          From
          <input className="filter-date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </label>
        <label className="filter-label">
          To
          <input className="filter-date" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </label>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_FILTERS} />
        <SubjectFilterControls filters={filters} />
      </div>
      <Async loading={register.loading} error={register.error} onRetry={register.reload} rows={8}>
        <DataTable
          caption="Attendance register"
          columns={dayColumns(canManage, onEdit, onCreate, { withDate: true })}
          rows={register.data?.items ?? []}
          rowKey={(row) => `${row.employee?.id}-${row.date}`}
          empty={<EmptyState icon={Clock} title="No attendance in this range" text="Try a wider range or other filters." />}
        />
        {totals && (
          <div className="summary-strip">
            <span>
              Present days<strong>{totals.presentDays}</strong>
            </span>
            <span>
              Late<strong>{totals.lateDays}</strong>
            </span>
            <span>
              Absent days<strong>{totals.absentDays}</strong>
            </span>
            <span>
              Worked<strong>{formatMinutes(totals.workedMinutes)}</strong>
            </span>
            <span>
              Overtime<strong>{formatMinutes(totals.overtimeMinutes)}</strong>
            </span>
          </div>
        )}
        <Pagination meta={register.data?.meta} onPage={setPage} />
      </Async>
    </>
  )
}

function EmployeePicker({ value, onChange, error }) {
  const people = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  return (
    <FormField label="Employee" error={error}>
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose an employee</option>
        {(people.data?.items ?? []).map((person) => (
          <option key={person.id} value={person.id}>
            {person.fullName} ({person.employeeNumber})
          </option>
        ))}
      </select>
    </FormField>
  )
}

const OVERRIDE_OPTIONS = [
  { value: '', label: 'Calculate from the times' },
  ...['PRESENT', 'LATE', 'ABSENT', 'PARTIAL', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND'].map((value) => ({ value, label: ATTENDANCE_LABELS[value] })),
]

function ManualForm({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState({
    employeeId: initial.employeeId ?? '',
    date: initial.date ?? todayIso(),
    checkIn: '',
    checkOut: '',
    status: '',
    notes: '',
    reason: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await createAttendanceRecord({
      employeeId: form.employeeId,
      date: form.date,
      checkIn: form.checkIn || undefined,
      checkOut: form.checkOut || undefined,
      status: form.status || undefined,
      notes: form.notes || undefined,
      reason: form.reason,
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      {initial.employeeName ? (
        <p>
          <strong>{initial.employeeName}</strong> · {formatDay(form.date)}
        </p>
      ) : (
        <EmployeePicker value={form.employeeId} onChange={(value) => set('employeeId', value)} error={error?.fieldError?.('employeeId')} />
      )}
      <div className="two-col">
        {!initial.date && (
          <FormField label="Date" error={error?.fieldError?.('date')}>
            <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required />
          </FormField>
        )}
        <FormField label="Check-in (local time)" error={error?.fieldError?.('checkIn')}>
          <input type="time" value={form.checkIn} onChange={(e) => set('checkIn', e.target.value)} />
        </FormField>
        <FormField label="Check-out (local time)" error={error?.fieldError?.('checkOut')}>
          <input type="time" value={form.checkOut} onChange={(e) => set('checkOut', e.target.value)} />
        </FormField>
        <FormField label="Status" hint="Leave on 'calculate' unless the day needs a fixed status.">
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {OVERRIDE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Notes">
        <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </FormField>
      <FormField label="Reason for the entry" error={error?.fieldError?.('reason')} hint="Recorded in the audit trail.">
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Forgot to check in" required />
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

function CorrectionForm({ day, onCancel, onSaved }) {
  const [form, setForm] = useState({
    checkIn: day.checkInLocal ?? '',
    checkOut: day.checkOutLocal ?? '',
    status: day.statusOverridden ? day.status : '',
    notes: day.notes ?? '',
    reason: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await correctAttendanceRecord(day.id, {
      checkIn: form.checkIn || null,
      checkOut: form.checkOut || null,
      status: form.status || null,
      notes: form.notes || null,
      reason: form.reason,
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <p>
        <strong>{day.employee?.fullName}</strong> · {formatDay(day.date)} · times in {day.timezone}
      </p>
      {day.correction && (
        <div className="notice">
          <Pencil size={16} />
          <span>
            Last corrected {formatDateTime(day.correction.correctedAt)}: {day.correction.reason}
          </span>
        </div>
      )}
      <div className="two-col">
        <FormField label="Check-in" error={error?.fieldError?.('checkIn')}>
          <input type="time" value={form.checkIn} onChange={(e) => set('checkIn', e.target.value)} />
        </FormField>
        <FormField label="Check-out" error={error?.fieldError?.('checkOut')}>
          <input type="time" value={form.checkOut} onChange={(e) => set('checkOut', e.target.value)} />
        </FormField>
        <FormField label="Status">
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {OVERRIDE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Notes">
          <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Reason for the correction" error={error?.fieldError?.('reason')} hint="Recorded in the audit trail with the before and after.">
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Save correction
        </button>
      </div>
    </form>
  )
}

function RecalculateForm({ onCancel, onSaved }) {
  const bounds = monthBounds(currentMonthKey())
  const [form, setForm] = useState({ from: bounds.from, to: todayIso(), employeeId: '', reason: '' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const result = await recalculateAttendance({
      from: form.from,
      to: form.to,
      employeeId: form.employeeId || undefined,
      reason: form.reason,
    })
    onSaved(result)
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <p className="muted">
        Re-evaluates stored days with the current schedules and policy - for example after changing the grace period. Days in an approved payroll month are
        left untouched.
      </p>
      <div className="two-col">
        <FormField label="From" error={error?.fieldError?.('from')}>
          <input type="date" value={form.from} onChange={(e) => set('from', e.target.value)} />
        </FormField>
        <FormField label="To" error={error?.fieldError?.('to')}>
          <input type="date" value={form.to} onChange={(e) => set('to', e.target.value)} />
        </FormField>
      </div>
      <EmployeePickerOptional value={form.employeeId} onChange={(value) => set('employeeId', value)} />
      <FormField label="Reason" error={error?.fieldError?.('reason')}>
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Grace period changed to 15 minutes" required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Recalculate
        </button>
      </div>
    </form>
  )
}

function EmployeePickerOptional({ value, onChange }) {
  const people = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  return (
    <FormField label="Employee" hint="Empty: everyone">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Everyone</option>
        {(people.data?.items ?? []).map((person) => (
          <option key={person.id} value={person.id}>
            {person.fullName}
          </option>
        ))}
      </select>
    </FormField>
  )
}

export { EmployeePicker }
