/**
 * Static UI constants only. Organisational data comes from the API.
 *
 * The demo accounts are a convenience for the seeded demo: the credentials
 * are still verified by the backend, so the list is a shortcut, not an
 * authentication path. The password is the documented demo default
 * (SEED_DEMO_PASSWORD) and never a production secret.
 */

/**
 * The one-click demo logins appear in development, where the demo is seeded,
 * and in a production build only when it is made with VITE_DEMO_ACCOUNTS=true.
 * A deployment set up with real accounts (`npm run db:setup`) must not offer
 * logins that do not exist.
 */
export function demoAccountsEnabled(env = import.meta.env) {
  return Boolean(env.DEV) || env.VITE_DEMO_ACCOUNTS === 'true'
}

export const DEMO_PASSWORD = 'Passw0rd!23'

export const DEMO_ACCOUNTS = [
  { label: 'Administrator', description: 'Khalid · General Manager', email: 'admin@pollux.demo' },
  { label: 'HR', description: 'Sara · HR Manager', email: 'hr@pollux.demo' },
  { label: 'Manager', description: 'Youssef · Sales Manager', email: 'manager@pollux.demo' },
  { label: 'Employee', description: 'Ahmed · Sales Executive', email: 'employee@pollux.demo' },
]

export const DOCUMENT_REQUEST_TYPES = [
  { value: 'EMPLOYMENT_CERTIFICATE', label: 'Employment certificate' },
  { value: 'SALARY_CERTIFICATE', label: 'Salary certificate' },
  { value: 'EXPERIENCE_LETTER', label: 'Experience letter' },
  { value: 'NOC_TRAVEL', label: 'No objection certificate (travel)' },
  { value: 'VISA_LETTER', label: 'Visa support letter' },
  { value: 'BANK_ACCOUNT_LETTER', label: 'Bank account letter' },
]

export const EMPLOYEE_STATUS_OPTIONS = [
  { value: 'PROBATION', label: 'Probation' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'NOTICE_PERIOD', label: 'Notice period' },
  { value: 'OFFBOARDED', label: 'Offboarded' },
]

export const EMPLOYMENT_TYPE_OPTIONS = [
  { value: 'FULL_TIME', label: 'Full-time' },
  { value: 'PART_TIME', label: 'Part-time' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'INTERN', label: 'Intern' },
]

export const WORK_MODE_OPTIONS = [
  { value: 'ONSITE', label: 'Office' },
  { value: 'HYBRID', label: 'Hybrid' },
  { value: 'REMOTE', label: 'Remote' },
  { value: 'FIELD', label: 'Field' },
]

export const CONTRACT_TYPE_OPTIONS = [
  { value: 'UNLIMITED', label: 'Unlimited' },
  { value: 'LIMITED', label: 'Limited term' },
]

export const ROLE_OPTIONS = [
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'MANAGER', label: 'Manager' },
  { value: 'HR_ADMIN', label: 'HR admin' },
  { value: 'ADMIN', label: 'Administrator' },
]

/** Common IANA zones for the people Pollux employs; any valid zone is accepted. */
export const TIMEZONE_OPTIONS = [
  'Asia/Dubai',
  'Africa/Cairo',
  'Africa/Algiers',
  'Asia/Riyadh',
  'Asia/Amman',
  'Asia/Beirut',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Manila',
  'Europe/London',
  'Europe/Istanbul',
  'Africa/Casablanca',
  'Africa/Lagos',
]

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
