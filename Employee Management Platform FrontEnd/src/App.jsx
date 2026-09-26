import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, CheckCircle2, ChevronRight, KeyRound, LogOut, Menu, X } from 'lucide-react'
import { Avatar, BrandMark, FormError, FormField, LoadingState, Modal, Spinner, Toast } from './components/ui.jsx'
import { ClockButton } from './components/attendance.jsx'
import { useAuth } from './hooks/useAuth.jsx'
import { CompanyProvider, useCompany } from './hooks/useCompany.jsx'
import { useResource } from './hooks/useResource.js'
import { useRoute } from './hooks/useRoute.js'
import { formatDate } from './lib/format.js'
import { allowedPages, defaultPage, locatePage, navigationFor } from './navigation.js'
import {
  changePassword,
  fetchNotifications,
  fetchRequests,
  markAllNotificationsRead,
  markNotificationRead,
} from './api/endpoints.js'
import LoginScreen from './pages/LoginScreen.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import HomePage from './pages/HomePage.jsx'
import EmployeesPage from './pages/EmployeesPage.jsx'
import DepartmentsPage from './pages/DepartmentsPage.jsx'
import WorkLocationsPage from './pages/WorkLocationsPage.jsx'
import AttendancePage from './pages/AttendancePage.jsx'
import TimesheetsPage from './pages/TimesheetsPage.jsx'
import WorkSchedulesPage from './pages/WorkSchedulesPage.jsx'
import OvertimePage from './pages/OvertimePage.jsx'
import RequestsPage from './pages/RequestsPage.jsx'
import LeaveBalancesPage from './pages/LeaveBalancesPage.jsx'
import HolidaysPage from './pages/HolidaysPage.jsx'
import PayrollPage from './pages/PayrollPage.jsx'
import AdvancesPage from './pages/AdvancesPage.jsx'
import AdjustmentsPage from './pages/AdjustmentsPage.jsx'
import PayslipsPage from './pages/PayslipsPage.jsx'
import DocumentsPage from './pages/DocumentsPage.jsx'
import ReportsPage from './pages/ReportsPage.jsx'
import UsersPage from './pages/UsersPage.jsx'
import AuditLogsPage from './pages/AuditLogsPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import MyAttendancePage from './pages/MyAttendancePage.jsx'
import MyRequestsPage from './pages/MyRequestsPage.jsx'
import MyPayPage from './pages/MyPayPage.jsx'
import MyProfilePage from './pages/MyProfilePage.jsx'
import MyTeamPage from './pages/MyTeamPage.jsx'
import CheckInPage from './pages/CheckInPage.jsx'

const PAGE_COMPONENTS = {
  dashboard: DashboardPage,
  home: HomePage,
  employees: EmployeesPage,
  departments: DepartmentsPage,
  'work-locations': WorkLocationsPage,
  attendance: AttendancePage,
  timesheets: TimesheetsPage,
  'work-schedules': WorkSchedulesPage,
  overtime: OvertimePage,
  requests: RequestsPage,
  'leave-balances': LeaveBalancesPage,
  holidays: HolidaysPage,
  payroll: PayrollPage,
  advances: AdvancesPage,
  adjustments: AdjustmentsPage,
  payslips: PayslipsPage,
  documents: DocumentsPage,
  reports: ReportsPage,
  users: UsersPage,
  'audit-logs': AuditLogsPage,
  settings: SettingsPage,
  'my-attendance': MyAttendancePage,
  'my-requests': MyRequestsPage,
  'my-pay': MyPayPage,
  'check-in': CheckInPage,
  'my-documents': DocumentsPage,
  'my-profile': MyProfilePage,
  'my-team': MyTeamPage,
}

export default function App() {
  const { session, bootstrapping } = useAuth()

  // Restoring a stored session is a network round trip; a boot screen avoids
  // flashing the login page to an already-signed-in user.
  if (bootstrapping) {
    return (
      <div className="boot-screen">
        <BrandMark size="lg" />
        <LoadingState label="Restoring your session…" />
      </div>
    )
  }

  if (!session) return <LoginScreen />

  return (
    <CompanyProvider>
      <Workspace session={session} />
    </CompanyProvider>
  )
}

function Workspace({ session }) {
  const { signOut } = useAuth()
  const route = useRoute()
  const [toast, setToast] = useState(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [securityOpen, setSecurityOpen] = useState(Boolean(session.mustChangePassword))

  const allowed = useMemo(() => allowedPages(session), [session])
  const page = allowed.has(route.page) ? route.page : defaultPage(session)

  const showToast = useCallback((message, type = 'success', options = {}) => {
    setToast({ message, type, id: Date.now(), ...options })
  }, [])

  useEffect(() => {
    setSecurityOpen(Boolean(session.mustChangePassword))
  }, [session.userId, session.mustChangePassword])

  const notifications = useResource(() => fetchNotifications(), [])
  const canDecide = session.isManagement || session.isManager
  const pending = useResource(
    () => (canDecide ? fetchRequests({ status: 'PENDING', pageSize: 1, myTeamOnly: !session.isManagement }) : Promise.resolve(null)),
    [canDecide],
  )

  const navigate = useCallback(
    (id, param) => {
      route.navigate(id, param)
      setMobileNavOpen(false)
      setNotificationsOpen(false)
      window.scrollTo({ top: 0 })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route.navigate],
  )

  const markEveryNotificationRead = async () => {
    try {
      const result = await markAllNotificationsRead()
      notifications.reload()
      showToast(`${result.updated} notification${result.updated === 1 ? '' : 's'} marked as read.`)
    } catch (error) {
      showToast(error.message || 'Could not update notifications.', 'error')
    }
  }

  const selectNotification = async (entry) => {
    if (!entry.isRead) {
      try {
        await markNotificationRead(entry.id)
        notifications.reload()
      } catch {
        // Navigation is still useful even when read-state persistence fails.
      }
    }
    const target = notificationTarget(entry, session)
    if (target && allowed.has(target)) navigate(target)
    else setNotificationsOpen(false)
  }

  const crumb = locatePage(session, page)
  const PageComponent = PAGE_COMPONENTS[page]

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <Sidebar
        session={session}
        page={page}
        onNavigate={navigate}
        onLogout={signOut}
        onSecurity={() => setSecurityOpen(true)}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        pendingCount={pending.data?.summary?.PENDING ?? 0}
      />

      <div className="workspace">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          {page === 'dashboard' || page === 'home' ? (
            <div className="topbar-title">
              <h1>{`${greeting()}, ${session.employee?.firstName ?? 'there'}`}</h1>
              <p>{formatDate(new Date(), { weekday: 'long' })}</p>
            </div>
          ) : (
            // Pages carry their own heading and description; the sticky bar
            // keeps the reader oriented once that heading has scrolled away.
            <nav className="topbar-title breadcrumb" aria-label="Breadcrumb">
              {crumb.group && (
                <>
                  <span>{crumb.group}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </>
              )}
              <h1>{crumb.label}</h1>
            </nav>
          )}
          <div className="topbar-actions">
            {session.employee && <ClockButton onToast={showToast} />}
            <button
              className="notification-button"
              aria-label="Notifications"
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <Bell size={18} />
              {(notifications.data?.unreadCount ?? 0) > 0 && <i />}
            </button>
            {notificationsOpen && (
              <NotificationsPopover
                state={notifications}
                onSelect={selectNotification}
                onMarkAll={markEveryNotificationRead}
                onClose={() => setNotificationsOpen(false)}
              />
            )}
          </div>
        </header>

        <main id="main-content" className="main-content">
          {PageComponent && (
            <PageComponent
              key={page}
              session={session}
              page={page}
              param={route.param}
              navigate={navigate}
              onToast={showToast}
              onPendingChanged={pending.reload}
            />
          )}
        </main>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
      <ChangePasswordModal
        open={securityOpen}
        forced={Boolean(session.mustChangePassword)}
        onClose={() => setSecurityOpen(false)}
        onComplete={signOut}
      />
    </div>
  )
}

function notificationTarget(entry, session) {
  const management = session.isManagement
  switch (entry.entityType) {
    case 'Request':
      return management || (session.isManager && entry.type === 'REQUEST_SUBMITTED') ? 'requests' : 'my-requests'
    case 'SalaryAdvance':
      return management ? 'advances' : 'my-pay'
    case 'PayrollPeriod':
      return 'my-pay'
    case 'Document':
      return management ? 'documents' : 'my-documents'
    case 'AttendanceRecord':
      return 'my-attendance'
    case 'OvertimeEntry':
      return management || session.isManager ? 'overtime' : 'my-attendance'
    case 'Employee':
      return management ? 'employees' : 'my-profile'
    default:
      return null
  }
}

function Sidebar({ session, page, onNavigate, onLogout, onSecurity, open, onClose, pendingCount }) {
  const { company, companyName } = useCompany()
  const groups = navigationFor(session)
  const user = session.employee
  const logo = company?.company?.logoUrl

  return (
    <>
      {open && <button className="nav-scrim" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <span className="brand">
            <BrandMark />
            <span>
              Pollux HR
              <small>People &amp; payroll</small>
            </span>
          </span>
          <button className="sidebar-close" onClick={onClose} aria-label="Close navigation">
            <X size={20} />
          </button>
        </div>

        <div className="company-chip">
          {logo ? <img src={logo} alt="" /> : <span className="company-logo">P</span>}
          <span>
            <strong>{companyName}</strong>
            <small>{company?.company ? `${company.company.city}, ${company.company.countryName}` : 'Dubai, UAE'}</small>
          </span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {groups.map((group, index) => (
            <div className="nav-group" key={group.label ?? `group-${index}`}>
              {group.label && <p className="nav-label">{group.label}</p>}
              {group.items.map((entry) => {
                const Icon = entry.icon
                return (
                  <button
                    className={page === entry.id ? 'active' : ''}
                    onClick={() => onNavigate(entry.id)}
                    key={entry.id}
                    aria-current={page === entry.id ? 'page' : undefined}
                  >
                    <Icon size={18} />
                    <span>{entry.label}</span>
                    {entry.id === 'requests' && pendingCount > 0 && <b>{pendingCount}</b>}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-fill" />

        <div className="sidebar-user">
          <Avatar employee={user} size="sm" />
          <span>
            <strong>{user?.fullName ?? session.email}</strong>
            <small>{formatRole(session.apiRole)}</small>
          </span>
          <button onClick={onSecurity} aria-label="Account security" title="Change password">
            <KeyRound size={16} />
          </button>
          <button onClick={onLogout} aria-label="Sign out" title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </aside>
    </>
  )
}

function NotificationsPopover({ state, onSelect, onMarkAll, onClose }) {
  const items = state.data?.items ?? []
  const unread = state.data?.unreadCount ?? 0

  return (
    <section className="notification-popover" aria-label="Notifications">
      <header>
        <h2>Notifications</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close notifications">
          <X size={17} />
        </button>
      </header>
      {state.loading && <LoadingState label="Loading notifications…" />}
      {state.error && <p className="notification-error">{state.error.message}</p>}
      {!state.loading && !state.error && (
        <div className="notification-list">
          {items.slice(0, 10).map((entry) => (
            <button className={entry.isRead ? '' : 'unread'} key={entry.id} onClick={() => onSelect(entry)}>
              <span className="notification-item-icon">{entry.isRead ? <CheckCircle2 size={16} /> : <Bell size={16} />}</span>
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.body}</small>
                <time>{formatDate(entry.createdAt, { year: undefined })}</time>
              </span>
            </button>
          ))}
          {!items.length && (
            <div className="notification-empty">
              <CheckCircle2 size={22} />
              <strong>You’re all caught up</strong>
              <p>Decisions, payslips and HR updates will appear here.</p>
            </div>
          )}
        </div>
      )}
      {unread > 0 && (
        <footer>
          <button className="text-button" onClick={onMarkAll}>
            Mark all {unread} as read
          </button>
        </footer>
      )}
    </section>
  )
}

function ChangePasswordModal({ open, forced, onClose, onComplete }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [complete, setComplete] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    setError(null)
    setSaving(false)
    setComplete(false)
  }, [open])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event) => {
    event.preventDefault()
    if (form.newPassword !== form.confirmPassword) {
      setError('The new password and confirmation do not match.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await changePassword(form.currentPassword, form.newPassword)
      setComplete(true)
    } catch (caught) {
      setError(caught)
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!forced && !complete}
      title={complete ? 'Password updated' : forced ? 'Set a new password' : 'Change password'}
      eyebrow={forced ? 'Required before continuing' : 'Account security'}
    >
      {complete ? (
        <div className="password-success">
          <span>
            <CheckCircle2 size={24} />
          </span>
          <h3>Your password has been changed.</h3>
          <p className="muted">All other sessions were signed out. Sign in again with your new password.</p>
          <button className="button button-primary button-wide" onClick={onComplete}>
            Return to sign in
          </button>
        </div>
      ) : (
        <form className="simple-form" onSubmit={submit} noValidate>
          <div className="security-callout">
            <KeyRound size={18} />
            <p>Use at least 10 characters with an uppercase letter, a lowercase letter and a number.</p>
          </div>
          <FormField label="Current password" error={error?.fieldError?.('currentPassword')}>
            <input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => set('currentPassword', event.target.value)} required />
          </FormField>
          <FormField label="New password" error={error?.fieldError?.('newPassword')}>
            <input type="password" autoComplete="new-password" value={form.newPassword} onChange={(event) => set('newPassword', event.target.value)} required />
          </FormField>
          <FormField label="Confirm new password">
            <input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => set('confirmPassword', event.target.value)} required />
          </FormField>
          <FormError error={error} />
          <div className="form-actions">
            {!forced && (
              <button type="button" className="button button-ghost" onClick={onClose}>
                Cancel
              </button>
            )}
            <button className="button button-primary" type="submit" disabled={saving}>
              {saving ? <Spinner size={16} /> : <KeyRound size={16} />} Change password
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export function formatRole(role) {
  return { ADMIN: 'Administrator', HR_ADMIN: 'HR admin', MANAGER: 'Manager', EMPLOYEE: 'Employee' }[role] ?? role
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}
