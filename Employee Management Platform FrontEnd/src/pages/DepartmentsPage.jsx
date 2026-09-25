import { useState } from 'react'
import { Building2, Pencil, Plus } from 'lucide-react'
import { Async, DataTable, EmptyState, FormError, FormField, Modal, PageHeader, Panel, Spinner, useSubmit } from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { createDepartment, fetchDepartments, fetchEmployees, updateDepartment } from '../api/endpoints.js'

export default function DepartmentsPage({ session, onToast }) {
  const departments = useResource(() => fetchDepartments(), [])
  const company = useCompany()
  const [editing, setEditing] = useState(null)

  const saved = (message) => {
    setEditing(null)
    departments.reload()
    company.reload()
    onToast(message)
  }

  return (
    <div className="page">
      <PageHeader
        title="Departments"
        description="Headcount counts current employees."
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setEditing({})}>
              <Plus size={16} /> Add department
            </button>
          )
        }
      />
      <Panel flush>
        <Async loading={departments.loading} error={departments.error} onRetry={departments.reload} rows={5}>
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Department',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.name}</strong>
                    <small>{row.description ?? row.code}</small>
                  </div>
                ),
              },
              { key: 'code', label: 'Code', render: (row) => <span className="mono">{row.code}</span> },
              { key: 'head', label: 'Head', render: (row) => row.head?.fullName ?? '—' },
              { key: 'headcount', label: 'People', className: 'num' },
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
            rows={departments.data ?? []}
            empty={<EmptyState icon={Building2} title="No departments yet" />}
          />
        </Async>
      </Panel>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : 'Add department'}>
        {editing && <DepartmentForm department={editing} onCancel={() => setEditing(null)} onSaved={saved} />}
      </Modal>
    </div>
  )
}

function DepartmentForm({ department, onCancel, onSaved }) {
  const isEdit = Boolean(department.id)
  const [form, setForm] = useState({
    code: department.code ?? '',
    name: department.name ?? '',
    description: department.description ?? '',
    headId: department.head?.id ?? '',
  })
  const people = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    const payload = { name: form.name, description: form.description || undefined, headId: form.headId || undefined }
    if (isEdit) await updateDepartment(department.id, payload)
    else await createDepartment({ ...payload, code: form.code })
    onSaved(isEdit ? 'Department updated.' : 'Department added.')
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        {!isEdit && (
          <FormField label="Code" error={error?.fieldError?.('code')} hint="Short, e.g. SALES">
            <input value={form.code} onChange={(e) => set('code', e.target.value)} required />
          </FormField>
        )}
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </FormField>
      </div>
      <FormField label="Description">
        <input value={form.description} onChange={(e) => set('description', e.target.value)} />
      </FormField>
      <FormField label="Head of department">
        <select value={form.headId} onChange={(e) => set('headId', e.target.value)}>
          <option value="">No head</option>
          {(people.data?.items ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.fullName} — {person.role}
            </option>
          ))}
        </select>
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
