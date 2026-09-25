import { useEffect, useState } from 'react'
import { Copy, KeyRound, Lock, Plus, ShieldCheck, Unlock, UserCog } from 'lucide-react'
import {
  Async,
  ConfirmDialog,
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
  StatusPill,
  useSubmit,
} from '../components/ui.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { relativeTime } from '../lib/format.js'
import { createUser, fetchEligibleEmployees, fetchUsers, resetUserPassword, unlockUser, updateUser } from '../api/endpoints.js'
import { ROLE_OPTIONS } from '../data.js'

const roleLabel = (role) => ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role

/**
 * Logins and roles. The rules live in the API: only an administrator grants
 * ADMIN or HR_ADMIN or touches those accounts, nobody changes their own
 * account here, and every change ends the person's open sessions.
 */
export default function UsersPage({ session, onToast }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [changingRole, setChangingRole] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [secret, setSecret] = useState(null)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [debounced, role, status])

  const users = useResource(() => fetchUsers({ q: debounced || undefined, role: role || undefined, status: status || undefined, page, pageSize: 25 }), [debounced, role, status, page])
  const summary = users.data?.summary ?? {}

  const run = async (action, message) => {
    try {
      const result = await action()
      users.reload()
      if (message) onToast(message)
      return result
    } catch (error) {
      onToast(error.message, 'error')
      return undefined
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Users & roles"
        description={`${summary.ADMIN ?? 0} administrators · ${summary.HR_ADMIN ?? 0} HR · ${summary.MANAGER ?? 0} managers · ${summary.EMPLOYEE ?? 0} employees`}
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Create login
          </button>
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Email or name" label="Search users" />
          <FilterSelect label="Role" value={role} onChange={setRole} options={[{ value: '', label: 'All roles' }, ...ROLE_OPTIONS]} />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'Any status' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'INACTIVE', label: 'Deactivated' },
              { value: 'LOCKED', label: 'Locked out' },
              { value: 'MUST_CHANGE_PASSWORD', label: 'Must change password' },
            ]}
          />
        </div>
        <Async loading={users.loading} error={users.error} onRetry={users.reload} rows={6}>
          <DataTable
            caption="Users"
            columns={[
              {
                key: 'user',
                label: 'User',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee?.fullName ?? row.email}</strong>
                    <small>
                      {row.email}
                      {row.isSelf ? ' · you' : ''}
                    </small>
                  </div>
                ),
              },
              { key: 'role', label: 'Role', render: (row) => roleLabel(row.role) },
              {
                key: 'status',
                label: 'Status',
                render: (row) => (
                  <div className="button-row">
                    <StatusPill status={row.isActive ? 'ACTIVE' : 'INACTIVE'} label={row.isActive ? 'Active' : 'Deactivated'} />
                    {row.isLocked && <StatusPill tone="danger" label="Locked" />}
                    {row.mustChangePassword && <StatusPill tone="warning" label="Temporary password" />}
                  </div>
                ),
              },
              { key: 'lastLogin', label: 'Last sign-in', render: (row) => (row.lastLoginAt ? relativeTime(row.lastLoginAt) : 'Never') },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  row.canManage ? (
                    <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                      <button className="button button-ghost button-sm" onClick={() => setChangingRole(row)}>
                        <UserCog size={14} /> Role
                      </button>
                      <button className="button button-ghost button-sm" onClick={() => setConfirm({ kind: 'reset', user: row })}>
                        <KeyRound size={14} /> Reset password
                      </button>
                      {row.isLocked && (
                        <button className="button button-ghost button-sm" onClick={() => run(() => unlockUser(row.id), `${row.email} unlocked.`)}>
                          <Unlock size={14} /> Unlock
                        </button>
                      )}
                      <button className="button button-ghost button-sm" onClick={() => setConfirm({ kind: row.isActive ? 'deactivate' : 'activate', user: row })}>
                        <Lock size={14} /> {row.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  ) : (
                    <span className="small muted">{row.isSelf ? 'Your account' : 'Administrator only'}</span>
                  ),
              },
            ]}
            rows={users.data?.items ?? []}
            empty={<EmptyState icon={ShieldCheck} title="No users found" />}
          />
          <Pagination meta={users.data?.meta} onPage={setPage} />
        </Async>
      </Panel>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create a login">
        {creating && (
          <CreateForm
            session={session}
            onCancel={() => setCreating(false)}
            onSaved={(result) => {
              setCreating(false)
              users.reload()
              setSecret({ email: result.user.email, password: result.temporaryPassword })
            }}
          />
        )}
      </Modal>
      <Modal open={Boolean(changingRole)} onClose={() => setChangingRole(null)} title="Change role" eyebrow={changingRole?.email}>
        {changingRole && (
          <RoleForm
            user={changingRole}
            session={session}
            onCancel={() => setChangingRole(null)}
            onSaved={() => {
              setChangingRole(null)
              users.reload()
              onToast('Role changed. Their open sessions were ended.')
            }}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={confirm?.kind === 'reset'}
        title="Reset password"
        message={`A new temporary password is created for ${confirm?.user.email}. They must change it at their next sign-in, and every open session ends now.`}
        confirmLabel="Reset password"
        onConfirm={async () => {
          const result = await resetUserPassword(confirm.user.id)
          users.reload()
          setSecret({ email: result.user.email, password: result.temporaryPassword })
        }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'deactivate' || confirm?.kind === 'activate'}
        title={confirm?.kind === 'deactivate' ? 'Deactivate login' : 'Reactivate login'}
        message={confirm?.kind === 'deactivate' ? `${confirm?.user.email} is signed out everywhere and cannot sign in until reactivated.` : `${confirm?.user.email} can sign in again.`}
        confirmLabel={confirm?.kind === 'deactivate' ? 'Deactivate' : 'Reactivate'}
        tone={confirm?.kind === 'deactivate' ? 'danger' : 'primary'}
        onConfirm={async () => {
          await updateUser(confirm.user.id, { isActive: confirm.kind === 'activate' })
          users.reload()
          onToast(confirm.kind === 'deactivate' ? 'Login deactivated.' : 'Login reactivated.')
        }}
        onClose={() => setConfirm(null)}
      />
      <Modal open={Boolean(secret)} onClose={() => setSecret(null)} title="Temporary password" eyebrow={secret?.email} size="sm">
        {secret && <SecretView secret={secret} onClose={() => setSecret(null)} />}
      </Modal>
    </div>
  )
}

function SecretView({ secret, onClose }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret.password)
      setCopied(true)
    } catch {
      // The password is selectable either way.
    }
  }
  return (
    <div className="simple-form">
      <p>Give this to the person securely. It is shown only once and they must change it when they sign in.</p>
      <div className="secret-box">
        <span>{secret.password}</span>
        <button className="button button-secondary button-sm" onClick={copy}>
          <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="form-actions">
        <button className="button button-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function CreateForm({ session, onCancel, onSaved }) {
  const eligible = useResource(() => fetchEligibleEmployees(), [])
  const [form, setForm] = useState({ employeeId: '', email: '', role: 'EMPLOYEE' })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    onSaved(await createUser({ employeeId: form.employeeId, email: form.email || undefined, role: form.role }))
  })
  const roles = ROLE_OPTIONS.filter((option) => session.isAdmin || ['EMPLOYEE', 'MANAGER'].includes(option.value))
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <Async loading={eligible.loading} error={eligible.error} rows={1}>
        <FormField label="Employee" error={error?.fieldError?.('employeeId')} hint={eligible.data?.length ? undefined : 'Everyone already has a login.'}>
          <select value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} required>
            <option value="">Choose an employee</option>
            {(eligible.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName} ({person.workEmail})
              </option>
            ))}
          </select>
        </FormField>
      </Async>
      <FormField label="Sign-in email" hint="Empty: the employee's work email" error={error?.fieldError?.('email')}>
        <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
      </FormField>
      <FormField label="Role" error={error?.fieldError?.('role')}>
        <select value={form.role} onChange={(e) => set('role', e.target.value)}>
          {roles.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving || !form.employeeId}>
          {saving && <Spinner size={15} />} Create login
        </button>
      </div>
    </form>
  )
}

function RoleForm({ user, session, onCancel, onSaved }) {
  const [role, setRole] = useState(user.role)
  const { submit, saving, error } = useSubmit(async () => {
    await updateUser(user.id, { role })
    onSaved()
  })
  const roles = ROLE_OPTIONS.filter((option) => session.isAdmin || ['EMPLOYEE', 'MANAGER'].includes(option.value))
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <FormField label="Role" error={error?.fieldError?.('role')}>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
      <p className="small muted">Managers see their team&apos;s attendance and requests - never salaries. HR admins see pay; administrators also change company settings.</p>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving || role === user.role}>
          {saving && <Spinner size={15} />} Save role
        </button>
      </div>
    </form>
  )
}
