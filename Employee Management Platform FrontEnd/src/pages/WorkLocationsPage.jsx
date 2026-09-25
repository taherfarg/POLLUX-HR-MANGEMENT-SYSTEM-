import { useState } from 'react'
import { MapPin, Pencil, Plus } from 'lucide-react'
import { Async, DataTable, EmptyState, FormError, FormField, Modal, PageHeader, Panel, Spinner, StatusPill, useSubmit } from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { createWorkLocation, fetchWorkLocations, updateWorkLocation } from '../api/endpoints.js'
import { WORK_LOCATION_KIND_LABELS } from '../api/adapters.js'
import { TIMEZONE_OPTIONS } from '../data.js'

/**
 * Where people work. A remote colleague in Cairo is a work location with a
 * Cairo timezone - never a branch or a separate company.
 */
export default function WorkLocationsPage({ session, onToast }) {
  const locations = useResource(() => fetchWorkLocations(session.isManagement), [session.isManagement])
  const company = useCompany()
  const [editing, setEditing] = useState(null)

  const saved = (message) => {
    setEditing(null)
    locations.reload()
    company.reload()
    onToast(message)
  }

  return (
    <div className="page">
      <PageHeader
        title="Work locations"
        description="The Dubai office, the field and remote locations. Each carries the timezone attendance is read in."
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setEditing({})}>
              <Plus size={16} /> Add location
            </button>
          )
        }
      />
      <Panel flush>
        <Async loading={locations.loading} error={locations.error} onRetry={locations.reload} rows={4}>
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Location',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.name}</strong>
                    <small>{[row.addressLine, row.city, row.countryName].filter(Boolean).join(', ') || '—'}</small>
                  </div>
                ),
              },
              { key: 'kind', label: 'Type', render: (row) => WORK_LOCATION_KIND_LABELS[row.kind] ?? row.kind },
              { key: 'timezone', label: 'Timezone', render: (row) => row.timezone ?? 'Company timezone' },
              { key: 'headcount', label: 'People', className: 'num', render: (row) => row.headcount ?? '—' },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  session.isManagement ? (
                    <button className="button button-ghost button-sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
                      <Pencil size={14} /> Edit
                    </button>
                  ) : null,
              },
            ]}
            rows={locations.data ?? []}
            empty={<EmptyState icon={MapPin} title="No work locations yet" />}
          />
        </Async>
      </Panel>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : 'Add work location'}>
        {editing && <LocationForm location={editing} onCancel={() => setEditing(null)} onSaved={saved} />}
      </Modal>
    </div>
  )
}

function LocationForm({ location, onCancel, onSaved }) {
  const isEdit = Boolean(location.id)
  const [form, setForm] = useState({
    code: location.code ?? '',
    name: location.name ?? '',
    kind: location.kind ?? 'OFFICE',
    addressLine: location.addressLine ?? '',
    city: location.city ?? '',
    countryCode: location.countryCode ?? '',
    countryName: location.countryName ?? '',
    timezone: location.timezone ?? '',
    isActive: location.isActive ?? true,
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const payload = {
      name: form.name,
      kind: form.kind,
      addressLine: form.addressLine || undefined,
      city: form.city || undefined,
      countryCode: form.countryCode ? form.countryCode.toUpperCase() : undefined,
      countryName: form.countryName || undefined,
      timezone: form.timezone || (isEdit ? null : undefined),
      isActive: form.isActive,
    }
    if (isEdit) await updateWorkLocation(location.id, payload)
    else await createWorkLocation({ ...payload, code: form.code })
    onSaved(isEdit ? 'Work location updated.' : 'Work location added.')
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        {!isEdit && (
          <FormField label="Code" error={error?.fieldError?.('code')} hint="e.g. REMOTE-CAI">
            <input value={form.code} onChange={(e) => set('code', e.target.value)} required />
          </FormField>
        )}
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Remote - Cairo" required />
        </FormField>
        <FormField label="Type">
          <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {Object.entries(WORK_LOCATION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Timezone" error={error?.fieldError?.('timezone')} hint="Attendance for people here is read in this zone.">
          <input list="location-timezones" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Dubai" />
          <datalist id="location-timezones">
            {TIMEZONE_OPTIONS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </FormField>
        <FormField label="City">
          <input value={form.city} onChange={(e) => set('city', e.target.value)} />
        </FormField>
        <FormField label="Country">
          <input value={form.countryName} onChange={(e) => set('countryName', e.target.value)} />
        </FormField>
        <FormField label="Country code" error={error?.fieldError?.('countryCode')}>
          <input value={form.countryCode} maxLength={2} onChange={(e) => set('countryCode', e.target.value)} placeholder="AE" />
        </FormField>
        <FormField label="Address">
          <input value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} />
        </FormField>
      </div>
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
