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
  ListTodo,
  MapPin,
  MessagesSquare,
  Palmtree,
  QrCode,
  ReceiptText,
  Scale,
  Settings,
  ShieldCheck,
  Sparkles,
  Timer,
  UserRound,
  UsersRound,
  Wallet,
} from './icons.js'

/**
 * Every page, its title and who it is offered to. Navigation is a convenience:
 * the API enforces every rule again, so a page reached by URL without the
 * right role simply shows the API's refusal. `tint` colours the page's icon
 * tile, so a page keeps one colour in the sidebar, the phone's menu and search.
 */
export const PAGES = {
  dashboard: { title: 'Dashboard', description: 'Today at Pollux Motors, and what needs your attention.', icon: Gauge, tint: 'blue' },
  home: { title: 'Home', description: 'Your day, your time off and your pay at a glance.', icon: Home, tint: 'blue' },
  tasks: { title: 'Tasks', description: 'Work given to you, by you and to your team.', icon: ListTodo, tint: 'orange' },
  chat: { title: 'Chat', description: 'Messages with colleagues, one to one or in groups.', icon: MessagesSquare, tint: 'green' },
  assistant: { title: 'Assistant', description: 'Ask about attendance, leave, approvals and tasks in your own words.', icon: Sparkles, tint: 'purple' },

  employees: { title: 'Employees', description: 'Everyone at Pollux Motors - office, field and remote.', icon: UsersRound, tint: 'blue' },
  departments: { title: 'Departments', description: 'Teams and who leads them.', icon: Building2, tint: 'indigo' },
  'work-locations': { title: 'Work locations', description: 'Where people work: the Dubai office, the field, remote.', icon: MapPin, tint: 'red' },

  attendance: { title: 'Attendance', description: 'Check-ins, lateness and absences, evaluated against each schedule.', icon: Clock, tint: 'teal' },
  timesheets: { title: 'Timesheets', description: 'Worked hours, lateness and overtime per person and period.', icon: CalendarRange, tint: 'cyan' },
  'work-schedules': { title: 'Work schedules', description: 'Working days, hours and breaks - and who follows which.', icon: CalendarClock, tint: 'indigo' },
  overtime: { title: 'Overtime', description: 'Overtime from attendance and manual entries, and their approval.', icon: Timer, tint: 'orange' },

  requests: { title: 'Requests', description: 'Leave, document and profile requests waiting for a decision.', icon: ClipboardCheck, tint: 'yellow' },
  'leave-balances': { title: 'Leave balances', description: 'Entitlement, carried over, used, pending and available days.', icon: Scale, tint: 'purple' },
  holidays: { title: 'Holidays', description: 'Holiday calendars: UAE by default, others where assigned.', icon: Palmtree, tint: 'green' },

  payroll: { title: 'Payroll runs', description: 'Calculate, review, approve and pay each month.', icon: Wallet, tint: 'green' },
  advances: { title: 'Salary advances', description: 'Advance requests, approvals and repayment through payroll.', icon: HandCoins, tint: 'teal' },
  adjustments: { title: 'Bonuses & deductions', description: 'One-off earnings and deductions, each approved before payroll.', icon: Coins, tint: 'yellow' },
  payslips: { title: 'Payslips', description: 'Payslips from approved payrolls, as stored PDFs.', icon: ReceiptText, tint: 'cyan' },

  documents: { title: 'Documents', description: 'Contracts, visas, certificates and payslips.', icon: FileText, tint: 'blue' },
  reports: { title: 'Reports', description: 'Attendance, leave, payroll and people reports with CSV, Excel and PDF export.', icon: BarChart3, tint: 'purple' },

  users: { title: 'Users & roles', description: 'Logins, roles and access.', icon: ShieldCheck, tint: 'gray' },
  'audit-logs': { title: 'Audit logs', description: 'Every sensitive action, who did it and when. Read-only.', icon: History, tint: 'gray' },
  settings: { title: 'Company settings', description: 'Company details and the policies every calculation uses.', icon: Settings, tint: 'gray' },

  'my-attendance': { title: 'My attendance', description: 'Check in and out, and your attendance history.', icon: Clock, tint: 'teal' },
  'my-requests': { title: 'My requests', description: 'Leave, documents and profile updates.', icon: CalendarDays, tint: 'red' },
  'my-pay': { title: 'My pay', description: 'Payslips and salary advances.', icon: Wallet, tint: 'green' },
  'my-documents': { title: 'My documents', description: 'Your contracts, certificates and payslips.', icon: FileText, tint: 'blue' },
  'my-profile': { title: 'My profile', description: 'Your personal and employment details.', icon: UserRound, tint: 'gray' },
  'my-team': { title: 'My team', description: 'Your direct reports, their attendance and requests.', icon: Layers, tint: 'indigo' },
  'check-in': { title: 'Check in', description: 'Check in or out with the office QR code.', icon: QrCode, tint: 'gray' },
}

const item = (id, label) => ({ id, label: label ?? PAGES[id].title, icon: PAGES[id].icon, tint: PAGES[id].tint })

/** Navigation groups for the session. */
export function navigationFor(session) {
  const self = session.employee
    ? [item('my-attendance'), item('my-requests'), item('my-pay'), item('my-profile')]
    : []

  if (session.isManagement) {
    return [
      { label: null, items: [item('dashboard'), item('assistant'), item('tasks'), item('chat')] },
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
      { label: null, items: [item('home'), item('assistant'), item('tasks'), item('chat')] },
      { label: 'Me', items: [...self.slice(0, 3), item('my-documents'), item('my-profile')] },
      {
        label: 'My team',
        items: [item('my-team', 'Team'), item('attendance', 'Team attendance'), item('requests', 'Approvals'), item('overtime'), item('reports')],
      },
    ]
  }

  return [
    { label: null, items: [item('home'), item('tasks'), item('chat')] },
    { label: 'Me', items: [...self.slice(0, 3), item('my-documents'), item('my-profile')] },
  ]
}

export function defaultPage(session) {
  return session.isManagement ? 'dashboard' : 'home'
}

/**
 * Pages reached from outside the navigation: the office QR code opens
 * #/check-in/<code> for anyone who checks in.
 */
const HIDDEN_PAGES = ['check-in']

/** Pages a session may open. Anything else falls back to its home page. */
export function allowedPages(session) {
  const pages = new Set(navigationFor(session).flatMap((group) => group.items.map((entry) => entry.id)))
  if (session.employee) for (const page of HIDDEN_PAGES) pages.add(page)
  return pages
}

/**
 * The phone's tab bar: the pages each role opens most, one tap away. Everything
 * else stays in the full navigation behind "More".
 */
export function quickNavFor(session) {
  const picks = session.isManagement
    ? [['dashboard'], ['employees'], ['requests'], ['chat']]
    : session.isManager
      ? [['home'], ['requests', 'Approvals'], ['tasks'], ['chat']]
      : [['home'], ['my-attendance', 'Attendance'], ['tasks'], ['chat']]
  const allowed = allowedPages(session)
  return picks.filter(([id]) => allowed.has(id)).map(([id, label]) => item(id, label))
}

/** Where a page sits in this session's navigation: { group, label } for the breadcrumb. */
export function locatePage(session, page) {
  for (const group of navigationFor(session)) {
    const entry = group.items.find((candidate) => candidate.id === page)
    if (entry) return { group: group.label, label: entry.label }
  }
  return { group: null, label: PAGES[page]?.title ?? '' }
}
