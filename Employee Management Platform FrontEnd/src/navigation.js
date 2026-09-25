import {
  BarChart3,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ClipboardCheck,
  Clock,
  Coins,
  FileText,
  Gauge,
  HandCoins,
  History,
  Home,
  Layers,
  MapPin,
  Palmtree,
  ReceiptText,
  Scale,
  Settings,
  ShieldCheck,
  Timer,
  UserRound,
  UsersRound,
  Wallet,
} from 'lucide-react'

/**
 * Every page, its title and who it is offered to. Navigation is a convenience:
 * the API enforces every rule again, so a page reached by URL without the
 * right role simply shows the API's refusal.
 */
export const PAGES = {
  dashboard: { title: 'Dashboard', description: 'Today at Pollux Motors, and what needs your attention.', icon: Gauge },
  home: { title: 'Home', description: 'Your day, your time off and your pay at a glance.', icon: Home },

  employees: { title: 'Employees', description: 'Everyone at Pollux Motors - office, field and remote.', icon: UsersRound },
  departments: { title: 'Departments', description: 'Teams and who leads them.', icon: Building2 },
  'work-locations': { title: 'Work locations', description: 'Where people work: the Dubai office, the field, remote.', icon: MapPin },

  attendance: { title: 'Attendance', description: 'Check-ins, lateness and absences, evaluated against each schedule.', icon: Clock },
  timesheets: { title: 'Timesheets', description: 'Worked hours, lateness and overtime per person and period.', icon: CalendarRange },
  'work-schedules': { title: 'Work schedules', description: 'Working days, hours and breaks - and who follows which.', icon: CalendarClock },
  overtime: { title: 'Overtime', description: 'Overtime from attendance and manual entries, and their approval.', icon: Timer },

  requests: { title: 'Requests', description: 'Leave, document and profile requests waiting for a decision.', icon: ClipboardCheck },
  'leave-balances': { title: 'Leave balances', description: 'Entitlement, carried over, used, pending and available days.', icon: Scale },
  holidays: { title: 'Holidays', description: 'Holiday calendars: UAE by default, others where assigned.', icon: Palmtree },

  payroll: { title: 'Payroll runs', description: 'Calculate, review, approve and pay each month.', icon: Wallet },
  advances: { title: 'Salary advances', description: 'Advance requests, approvals and repayment through payroll.', icon: HandCoins },
  adjustments: { title: 'Bonuses & deductions', description: 'One-off earnings and deductions, each approved before payroll.', icon: Coins },
  payslips: { title: 'Payslips', description: 'Payslips from approved payrolls, as stored PDFs.', icon: ReceiptText },

  documents: { title: 'Documents', description: 'Contracts, visas, certificates and payslips.', icon: FileText },
  reports: { title: 'Reports', description: 'Attendance, leave, payroll and people reports with CSV, Excel and PDF export.', icon: BarChart3 },

  users: { title: 'Users & roles', description: 'Logins, roles and access.', icon: ShieldCheck },
  'audit-logs': { title: 'Audit logs', description: 'Every sensitive action, who did it and when. Read-only.', icon: History },
  settings: { title: 'Company settings', description: 'Company details and the policies every calculation uses.', icon: Settings },

  'my-attendance': { title: 'My attendance', description: 'Check in and out, and your attendance history.', icon: Clock },
  'my-requests': { title: 'My requests', description: 'Leave, documents and profile updates.', icon: CalendarDays },
  'my-pay': { title: 'My pay', description: 'Payslips and salary advances.', icon: Wallet },
  'my-documents': { title: 'My documents', description: 'Your contracts, certificates and payslips.', icon: FileText },
  'my-profile': { title: 'My profile', description: 'Your personal and employment details.', icon: UserRound },
  'my-team': { title: 'My team', description: 'Your direct reports, their attendance and requests.', icon: Layers },
}

const item = (id, label) => ({ id, label: label ?? PAGES[id].title, icon: PAGES[id].icon })

/** Navigation groups for the session. */
export function navigationFor(session) {
  const self = session.employee
    ? [item('my-attendance'), item('my-requests'), item('my-pay'), item('my-profile')]
    : []

  if (session.isManagement) {
    return [
      { label: null, items: [item('dashboard')] },
      { label: 'People', items: [item('employees'), item('departments'), item('work-locations')] },
      { label: 'Time', items: [item('attendance'), item('timesheets'), item('work-schedules'), item('overtime')] },
      { label: 'Leave', items: [item('requests'), item('leave-balances'), item('holidays')] },
      { label: 'Payroll', items: [item('payroll'), item('advances'), item('adjustments'), item('payslips')] },
      { label: null, items: [item('documents'), item('reports')] },
      { label: 'Administration', items: [item('users'), item('audit-logs'), item('settings')] },
      ...(self.length ? [{ label: 'Me', items: self }] : []),
    ]
  }

  if (session.isManager) {
    return [
      { label: null, items: [item('home')] },
      { label: 'Me', items: [...self.slice(0, 3), item('my-documents'), item('my-profile')] },
      {
        label: 'My team',
        items: [item('my-team', 'Team'), item('attendance', 'Team attendance'), item('requests', 'Approvals'), item('overtime'), item('reports')],
      },
    ]
  }

  return [
    { label: null, items: [item('home')] },
    { label: 'Me', items: [...self.slice(0, 3), item('my-documents'), item('my-profile')] },
  ]
}

export function defaultPage(session) {
  return session.isManagement ? 'dashboard' : 'home'
}

/** Pages a session may open. Anything else falls back to its home page. */
export function allowedPages(session) {
  return new Set(navigationFor(session).flatMap((group) => group.items.map((entry) => entry.id)))
}

/** Where a page sits in this session's navigation: { group, label } for the breadcrumb. */
export function locatePage(session, page) {
  for (const group of navigationFor(session)) {
    const entry = group.items.find((candidate) => candidate.id === page)
    if (entry) return { group: group.label, label: entry.label }
  }
  return { group: null, label: PAGES[page]?.title ?? '' }
}
