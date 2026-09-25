import { useMemo, useState } from 'react'
import { CalendarClock, Pencil, Plus, UserCheck } from 'lucide-react'
import { Async, Chip, DataTable, EmptyState, FormError, FormField, Modal, PageHeader, Panel, SearchInput, Spinner, StatusPill, useSubmit } from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatMinutes } from '../lib/format.js'
import { assignWorkSchedule, createWorkSchedule, fetchEmployees, fetchWorkSchedules, updateWorkSchedule } from '../api/endpoints.js'
import { TIMEZONE_OPTIONS, WEEKDAY_NAMES } from '../data.js'

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Monday first, the way the week is written in the UAE since 2022.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export default function WorkSchedulesPage({ session, onToast }) {
  const schedules = useResource(() => fetchWorkSchedules(session.isManagement), [session.isManagement])
  const company = useCompany()
  const [editing, setEditing] = useState(null)
  const [assigning, setAssigning] = useState(null)

  const saved = (message) => {
    setEditing(null)
    setAssigning(null)
    schedules.reload()
    company.reload()
    onToast(message)
  }

  return (
    <div className="page">
      <PageHeader
        title="Work schedules"
        description="Working days, hours and breaks. People without a schedule follow the company default."
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setEditing({})}>
              <Plus size={16} /> New schedule
            </button>
          )
        }
      />
      <Panel flush>
        <Async loading={schedules.loading} error={schedules.error} onRetry={schedules.reload} rows={4}>
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Schedule',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>
                      {row.name} {row.isCompanyDefault && <Chip>Company default</Chip>}
                    </strong>
                    <small>{row.description ?? row.code}</small>
                  </div>
                ),
              },
              {
                key: 'days',
                label: 'Working days',
                render: (row) => (
                  <div>
                    <strong>{DAY_ORDER.filter((day) => row.workingDays.includes(day)).map((day) => SHORT_DAYS[day]).join(', ')}</strong>
                    <small>{describeHours(row.days)}</small>
                  </div>
                ),
              },
              { key: 'weekly', label: 'Per week', className: 'num', render: (row) => formatMinutes(row.weeklyMinutes) },
              { key: 'timezone', label: 'Timezone', render: (row) => (row.timezone ? row.timezone : "Each person's own") },
              { key: 'employeeCount', label: 'People', className: 'num', render: (row) => row.employeeCount ?? '—' },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  session.isManagement && (
                    <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                      <button className="button button-ghost button-sm" onClick={() => setAssigning(row)}>
                        <UserCheck size={14} /> Assign
                      </button>
                      <button className="button button-ghost button-sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
                        <Pencil size={14} /> Edit
                      </button>
                    </div>
                  ),
              },
            ]}
            rows={schedules.data ?? []}
            empty={<EmptyState icon={CalendarClock} title="No schedules yet" />}
          />
        </Async>
      </Panel>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : 'New work schedule'} size="lg">
        {editing && <ScheduleForm schedule={editing} onCancel={() => setEditing(null)} onSaved={saved} />}
      </Modal>
      <Modal open={Boolean(assigning)} onClose={() => setAssigning(null)} title={`Assign ${assigning?.name ?? ''}`} eyebrow="Work schedule">
        {assigning && <AssignForm schedule={assigning} onCancel={() => setAssigning(null)} onSaved={saved} />}
      </Modal>
    </div>
  )
}

function describeHours(days) {
  const working = days.filter((day) => day.isWorkingDay)
  const distinct = new Set(working.map((day) => `${day.startTime}–${day.endTime}`))
  if (distinct.size === 1) {
    const day = working[0]
    return `${day.startTime}–${day.endTime}${day.breakMinutes ? `, ${day.breakMinutes} min break` : ''}`
  }
  return 'Varies by day'
}

function ScheduleForm({ schedule, onCancel, onSaved }) {
  const isEdit = Boolean(schedule.id)
  const [form, setForm] = useState(() => ({
    code: schedule.code ?? '',
    name: schedule.name ?? '',
    description: schedule.description ?? '',
    timezone: schedule.timezone ?? '',
    isActive: schedule.isActive ?? true,
    days: Array.from({ length: 7 }, (_, dayOfWeek) => {
      const day = schedule.days?.find((candidate) => candidate.dayOfWeek === dayOfWeek)
      const workingByDefault = !schedule.id && dayOfWeek >= 1 && dayOfWeek <= 5
      return {
        dayOfWeek,
        isWorkingDay: day ? day.isWorkingDay : workingByDefault,
        startTime: day?.startTime ?? '09:00',
        endTime: day?.endTime ?? '18:00',
        breakMinutes: day?.breakMinutes ?? 60,
      }
    }),
  }))
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const setDay = (dayOfWeek, key, value) =>
    setForm((state) => ({ ...state, days: state.days.map((day) => (day.dayOfWeek === dayOfWeek ? { ...day, [key]: value } : day)) }))

  const { submit, saving, error } = useSubmit(async () => {
    const days = form.days.map((day) =>
      day.isWorkingDay
        ? { dayOfWeek: day.dayOfWeek, isWorkingDay: true, startTime: day.startTime, endTime: day.endTime, breakMinutes: Number(day.breakMinutes || 0) }
        : { dayOfWeek: day.dayOfWeek, isWorkingDay: false },
    )
    const payload = {
      name: form.name,
      description: form.description || undefined,
      timezone: form.timezone || (isEdit ? null : undefined),
      isActive: form.isActive,
      days,
    }
    if (isEdit) await updateWorkSchedule(schedule.id, payload)
    else await createWorkSchedule({ ...payload, code: form.code })
    onSaved(isEdit ? 'Schedule updated. Recalculate attendance if past days should follow it.' : 'Schedule created.')
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        {!isEdit && (
          <FormField label="Code" error={error?.fieldError?.('code')} hint="e.g. STD-DXB">
            <input value={form.code} onChange={(e) => set('code', e.target.value)} required />
          </FormField>
        )}
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Standard Dubai Office" required />
        </FormField>
        <FormField label="Timezone" error={error?.fieldError?.('timezone')} hint="Empty: each person's own timezone (for remote teams).">
          <input list="schedule-timezones" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Dubai" />
          <datalist id="schedule-timezones">
            {TIMEZONE_OPTIONS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Description">
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>
      </div>
      <div className="schedule-grid" role="group" aria-label="Weekly hours">
        <div className="schedule-row small muted">
          <span>Day</span>
          <span>Working</span>
          <span>Start</span>
          <span>End</span>
          <span>Break (min)</span>
        </div>
        {DAY_ORDER.map((dayOfWeek) => {
          const day = form.days[dayOfWeek]
          return (
            <div className="schedule-row" key={dayOfWeek}>
              <span className="day">{WEEKDAY_NAMES[dayOfWeek]}</span>
              <label className="check">
                <input type="checkbox" checked={day.isWorkingDay} onChange={(e) => setDay(dayOfWeek, 'isWorkingDay', e.target.checked)} aria-label={`${WEEKDAY_NAMES[dayOfWeek]} is a working day`} />
                {day.isWorkingDay ? 'Yes' : 'Off'}
              </label>
              <input className="input" type="time" value={day.startTime} disabled={!day.isWorkingDay} onChange={(e) => setDay(dayOfWeek, 'startTime', e.target.value)} aria-label={`${WEEKDAY_NAMES[dayOfWeek]} start`} />
              <input className="input" type="time" value={day.endTime} disabled={!day.isWorkingDay} onChange={(e) => setDay(dayOfWeek, 'endTime', e.target.value)} aria-label={`${WEEKDAY_NAMES[dayOfWeek]} end`} />
              <input className="input" type="number" min="0" max="240" value={day.breakMinutes} disabled={!day.isWorkingDay} onChange={(e) => setDay(dayOfWeek, 'breakMinutes', e.target.value)} aria-label={`${WEEKDAY_NAMES[dayOfWeek]} break minutes`} />
            </div>
          )
        })}
      </div>
      {error?.fieldError?.('days') && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error.fieldError('days')}</p>}
      <label className="check">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
      </label>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Save schedule
        </button>
      </div>
    </form>
  )
}

function AssignForm({ schedule, onCancel, onSaved }) {
  const people = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  const [selected, setSelected] = useState(() => new Set())
  const [query, setQuery] = useState('')
  const list = useMemo(
    () => (people.data?.items ?? []).filter((person) => person.fullName.toLowerCase().includes(query.toLowerCase())),
    [people.data, query],
  )
  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const { submit, saving, error } = useSubmit(async () => {
    await assignWorkSchedule(schedule.id, [...selected])
    onSaved(`${schedule.name} assigned to ${selected.size} ${selected.size === 1 ? 'person' : 'people'}.`)
  })

  return (
    <form className="simple-form" onSubmit={submit}>
      <SearchInput value={query} onChange={setQuery} placeholder="Find people" />
      <Async loading={people.loading} error={people.error} rows={4}>
        <div className="list" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {list.map((person) => (
            <label className="list-row check" key={person.id}>
              <input type="checkbox" checked={selected.has(person.id)} onChange={() => toggle(person.id)} />
              <span className="grow">
                <strong>{person.fullName}</strong>
                <small>{person.role}</small>
              </span>
            </label>
          ))}
        </div>
      </Async>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving || selected.size === 0}>
          {saving && <Spinner size={15} />} Assign to {selected.size}
        </button>
      </div>
    </form>
  )
}
