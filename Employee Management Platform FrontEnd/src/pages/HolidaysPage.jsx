import { useEffect, useState } from 'react'
import { Palmtree, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  Async,
  Chip,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FilterSelect,
  FormError,
  FormField,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  useSubmit,
} from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate } from '../lib/format.js'
import { createHoliday, createHolidayCalendar, deleteHoliday, fetchHolidayCalendars, fetchHolidays, updateHoliday, updateHolidayCalendar } from '../api/endpoints.js'

const thisYear = new Date().getFullYear()

/**
 * Holiday calendars. The Pollux UAE calendar is everyone's default; a remote
 * colleague can be assigned another one. Nothing is assumed from a country.
 */
export default function HolidaysPage({ session, onToast }) {
  const company = useCompany()
  const calendars = useResource(() => fetchHolidayCalendars(), [])
  const [calendarId, setCalendarId] = useState('')
  const [year, setYear] = useState(thisYear)
  const [editingHoliday, setEditingHoliday] = useState(null)
  const [editingCalendar, setEditingCalendar] = useState(null)
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    if (!calendarId && calendars.data?.length) {
      setCalendarId((calendars.data.find((calendar) => calendar.isCompanyDefault) ?? calendars.data[0]).id)
    }
  }, [calendars.data, calendarId])

  const holidays = useResource(() => (calendarId ? fetchHolidays({ calendarId, year }) : Promise.resolve([])), [calendarId, year])
  const calendar = calendars.data?.find((item) => item.id === calendarId)
  const manage = session.isManagement

  const rows = (holidays.data ?? [])
    .map((holiday) => ({ ...holiday, shownDate: holiday.isRecurringAnnually ? `${year}${String(holiday.date).slice(4)}` : holiday.date }))
    .sort((a, b) => a.shownDate.localeCompare(b.shownDate))

  return (
    <div className="page">
      <PageHeader
        title="Holidays"
        description="Holidays are never charged as leave and never count as absence."
        actions={
          manage && (
            <>
              <button className="button button-secondary" onClick={() => setEditingCalendar({})}>
                <Plus size={16} /> New calendar
              </button>
              <button className="button button-primary" onClick={() => setEditingHoliday({ calendarId })} disabled={!calendarId}>
                <Plus size={16} /> Add holiday
              </button>
            </>
          )
        }
      />
      <Panel flush>
        <div className="toolbar">
          <FilterSelect
            label="Calendar"
            value={calendarId}
            onChange={setCalendarId}
            options={(calendars.data ?? []).map((item) => ({ value: item.id, label: `${item.name}${item.isCompanyDefault ? ' (default)' : ''}` }))}
          />
          <FilterSelect
            label="Year"
            value={String(year)}
            onChange={(value) => setYear(Number(value))}
            options={[thisYear - 1, thisYear, thisYear + 1].map((value) => ({ value: String(value), label: String(value) }))}
          />
          <span className="spacer" />
          {calendar && (
            <span className="small muted">
              {calendar.isCompanyDefault ? 'Company default · ' : ''}
              {calendar.assignedEmployees} assigned explicitly
            </span>
          )}
          {manage && calendar && (
            <button className="button button-ghost button-sm" onClick={() => setEditingCalendar(calendar)}>
              <Pencil size={14} /> Edit calendar
            </button>
          )}
        </div>
        <Async loading={calendars.loading || holidays.loading} error={calendars.error || holidays.error} onRetry={holidays.reload} rows={6}>
          <DataTable
            caption="Holidays"
            columns={[
              { key: 'date', label: 'Date', primary: true, render: (row) => <strong>{formatDate(row.shownDate, { weekday: 'short' })}</strong> },
              { key: 'name', label: 'Holiday' },
              {
                key: 'type',
                label: 'Type',
                render: (row) => (
                  <div className="button-row">
                    <Chip>{row.type === 'COMPANY' ? 'Company day' : 'Public holiday'}</Chip>
                    {row.isRecurringAnnually && <Chip>Every year</Chip>}
                  </div>
                ),
              },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  manage ? (
                    <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                      <button className="button button-ghost button-sm" onClick={() => setEditingHoliday(row)} aria-label={`Edit ${row.name}`}>
                        <Pencil size={14} />
                      </button>
                      <button className="button button-ghost button-sm" onClick={() => setDeleting(row)} aria-label={`Delete ${row.name}`}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : null,
              },
            ]}
            rows={rows}
            empty={<EmptyState icon={Palmtree} title={`No holidays in ${year}`} text="Add the year's holidays as they are announced." />}
          />
        </Async>
      </Panel>

      <Modal open={Boolean(editingHoliday)} onClose={() => setEditingHoliday(null)} title={editingHoliday?.id ? 'Edit holiday' : 'Add holiday'} eyebrow={calendar?.name}>
        {editingHoliday && (
          <HolidayForm
            holiday={editingHoliday}
            calendarId={calendarId}
            onCancel={() => setEditingHoliday(null)}
            onSaved={(message) => {
              setEditingHoliday(null)
              holidays.reload()
              onToast(message)
            }}
          />
        )}
      </Modal>
      <Modal open={Boolean(editingCalendar)} onClose={() => setEditingCalendar(null)} title={editingCalendar?.id ? 'Edit calendar' : 'New holiday calendar'}>
        {editingCalendar && (
          <CalendarForm
            calendar={editingCalendar}
            onCancel={() => setEditingCalendar(null)}
            onSaved={(message, saved) => {
              setEditingCalendar(null)
              calendars.reload()
              company.reload()
              if (saved?.id) setCalendarId(saved.id)
              onToast(message)
            }}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete holiday"
        message={deleting ? `Delete ${deleting.name}? Attendance and leave for that day are re-evaluated as a working day.` : ''}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          await deleteHoliday(deleting.id)
          holidays.reload()
          onToast('Holiday deleted.')
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

function HolidayForm({ holiday, calendarId, onCancel, onSaved }) {
  const isEdit = Boolean(holiday.id)
  const [form, setForm] = useState({
    name: holiday.name ?? '',
    date: holiday.date ?? '',
    type: holiday.type ?? 'PUBLIC',
    isRecurringAnnually: holiday.isRecurringAnnually ?? false,
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    if (isEdit) await updateHoliday(holiday.id, form)
    else await createHoliday({ ...form, calendarId })
    onSaved(isEdit ? 'Holiday updated.' : 'Holiday added.')
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <FormField label="Name" error={error?.fieldError?.('name')}>
        <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="UAE National Day" required />
      </FormField>
      <div className="two-col">
        <FormField label="Date" error={error?.fieldError?.('date')}>
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required />
        </FormField>
        <FormField label="Type">
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="PUBLIC">Public holiday</option>
            <option value="COMPANY">Company day off</option>
          </select>
        </FormField>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.isRecurringAnnually} onChange={(e) => set('isRecurringAnnually', e.target.checked)} /> Same date every year
      </label>
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

function CalendarForm({ calendar, onCancel, onSaved }) {
  const isEdit = Boolean(calendar.id)
  const [form, setForm] = useState({
    code: calendar.code ?? '',
    name: calendar.name ?? '',
    countryCode: calendar.countryCode ?? '',
    description: calendar.description ?? '',
    isActive: calendar.isActive ?? true,
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const payload = {
      name: form.name,
      countryCode: form.countryCode ? form.countryCode.toUpperCase() : undefined,
      description: form.description || undefined,
      isActive: form.isActive,
    }
    const saved = isEdit ? await updateHolidayCalendar(calendar.id, payload) : await createHolidayCalendar({ ...payload, code: form.code })
    onSaved(isEdit ? 'Calendar updated.' : 'Calendar created.', saved)
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        {!isEdit && (
          <FormField label="Code" error={error?.fieldError?.('code')}>
            <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="EGY" required />
          </FormField>
        )}
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Egypt Public Holidays" required />
        </FormField>
        <FormField label="Country code" error={error?.fieldError?.('countryCode')} hint="For reference only">
          <input value={form.countryCode} maxLength={2} onChange={(e) => set('countryCode', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Description">
        <input value={form.description} onChange={(e) => set('description', e.target.value)} />
      </FormField>
      <label className="check">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
      </label>
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
