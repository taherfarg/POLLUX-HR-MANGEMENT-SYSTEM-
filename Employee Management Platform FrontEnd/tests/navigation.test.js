import { describe, expect, it } from 'vitest'
import { allowedPages, defaultPage, locatePage, navigationFor } from '../src/navigation.js'

const employee = { id: 'e1', firstName: 'Ahmed' }
const sessions = {
  admin: { isManagement: true, isAdmin: true, isManager: false, employee },
  hr: { isManagement: true, isAdmin: false, isManager: false, employee },
  manager: { isManagement: false, isAdmin: false, isManager: true, employee },
  employee: { isManagement: false, isAdmin: false, isManager: false, employee },
}

const PAY_PAGES = ['payroll', 'advances', 'adjustments', 'payslips']
const ADMIN_PAGES = ['users', 'audit-logs', 'settings']

describe('navigation by role', () => {
  it('gives HR and administrators the Pollux sections in order, with no legal entities', () => {
    const groups = navigationFor(sessions.hr)
    expect(groups.map((group) => group.label)).toEqual([null, 'People', 'Time', 'Leave', 'Payroll', null, 'Administration', 'Me'])
    const labels = groups.flatMap((group) => group.items.map((item) => item.label))
    expect(labels).toEqual(
      expect.arrayContaining([
        'Dashboard',
        'Employees',
        'Departments',
        'Work locations',
        'Attendance',
        'Timesheets',
        'Work schedules',
        'Overtime',
        'Requests',
        'Leave balances',
        'Holidays',
        'Payroll runs',
        'Salary advances',
        'Bonuses & deductions',
        'Payslips',
        'Documents',
        'Reports',
        'Users & roles',
        'Audit logs',
        'Company settings',
      ]),
    )
    expect(labels.join(' ')).not.toMatch(/legal entit/i)
  })

  it('never offers a manager payroll, pay or administration pages', () => {
    const pages = allowedPages(sessions.manager)
    for (const page of [...PAY_PAGES, ...ADMIN_PAGES, 'employees', 'dashboard']) expect(pages.has(page)).toBe(false)
    for (const page of ['home', 'my-team', 'attendance', 'requests', 'overtime', 'reports', 'my-pay']) expect(pages.has(page)).toBe(true)
  })

  it('gives an employee only their own pages', () => {
    const pages = [...allowedPages(sessions.employee)].sort()
    expect(pages).toEqual(['home', 'my-attendance', 'my-documents', 'my-pay', 'my-profile', 'my-requests'])
  })

  it('lands management on the dashboard and everyone else at home', () => {
    expect(defaultPage(sessions.admin)).toBe('dashboard')
    expect(defaultPage(sessions.hr)).toBe('dashboard')
    expect(defaultPage(sessions.manager)).toBe('home')
    expect(defaultPage(sessions.employee)).toBe('home')
  })

  it('names the breadcrumb from the role’s own navigation', () => {
    expect(locatePage(sessions.hr, 'payroll')).toEqual({ group: 'Payroll', label: 'Payroll runs' })
    expect(locatePage(sessions.manager, 'requests')).toEqual({ group: 'My team', label: 'Approvals' })
    expect(locatePage(sessions.employee, 'my-pay')).toEqual({ group: 'Me', label: 'My pay' })
    expect(locatePage(sessions.hr, 'reports')).toEqual({ group: null, label: 'Reports' })
  })
})
