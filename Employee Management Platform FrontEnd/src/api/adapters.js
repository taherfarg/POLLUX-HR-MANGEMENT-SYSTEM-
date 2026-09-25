/**
 * Translates API payloads into the shapes the UI components render.
 *
 * Keeping this mapping in one place means the components stay declarative and
 * the API is free to change field names without a rewrite of the view layer.
 * It is also where presentation-only concerns live - avatar colours, initials,
 * and the human labels for the API's SCREAMING_CASE enums.
 */

import { plural } from '../lib/format.js'

// --- Enum labels ----------------------------------------------------------
// The label strings double as CSS modifiers via StatusPill, which lowercases
// them and replaces spaces with hyphens (Active -> .status-active).

export const EMPLOYEE_STATUS_LABELS = {
  PROBATION: 'Probation',
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  NOTICE_PERIOD: 'Notice period',
  OFFBOARDED: 'Offboarded',
}

export const REQUEST_STATUS_LABELS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}

export const EMPLOYMENT_TYPE_LABELS = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
}

export const WORK_MODE_LABELS = {
  ONSITE: 'Office',
  HYBRID: 'Hybrid',
  REMOTE: 'Remote',
  FIELD: 'Field',
}

export const WORK_LOCATION_KIND_LABELS = {
  OFFICE: 'Office',
  REMOTE: 'Remote',
  FIELD: 'Field',
  OTHER: 'Other',
}

export const CONTRACT_TYPE_LABELS = {
  UNLIMITED: 'Unlimited',
  LIMITED: 'Limited term',
}

export const REQUEST_TYPE_LABELS = {
  LEAVE: 'Leave',
  DOCUMENT: 'Document',
  PROFILE_CHANGE: 'Profile',
}

export const DOCUMENT_TYPE_LABELS = {
  EMPLOYMENT_CERTIFICATE: 'Employment certificate',
  SALARY_CERTIFICATE: 'Salary certificate',
  EXPERIENCE_LETTER: 'Experience letter',
  NOC_TRAVEL: 'No objection certificate',
  VISA_LETTER: 'Visa support letter',
  BANK_ACCOUNT_LETTER: 'Bank account letter',
}

/** Reverse lookup for turning a UI label back into the value the API expects. */
export const EMPLOYEE_STATUS_VALUES = Object.fromEntries(
  Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => [label, value]),
)

export const REQUEST_STATUS_VALUES = Object.fromEntries(
  Object.entries(REQUEST_STATUS_LABELS).map(([value, label]) => [label, value]),
)

// --- Presentation helpers -------------------------------------------------

const AVATAR_PALETTE = [
  '#e9b7a5', '#9ec7bd', '#f0c96d', '#b9add7', '#d8b58a',
  '#93b5d3', '#e8a8b5', '#b8d1a7', '#efad82', '#a9c3d4',
  '#d6a6cc', '#8fc9c3', '#f1c76f', '#bfbb9c',
]

const ENTITY_PALETTE = [
  { color: '#ee6a45', accent: '#fee6dc' },
  { color: '#20786e', accent: '#dcefeb' },
  { color: '#6d5bd0', accent: '#e6e2fb' },
  { color: '#b5762a', accent: '#f8ebd8' },
]

/**
 * Stable colour per record. The API has no opinion on presentation, but the
 * same person must keep the same avatar colour between renders and reloads, so
 * it is derived from the id rather than assigned by list position.
 */
function paletteIndex(seed, size) {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  return hash % size
}

export function avatarColor(id = '') {
  return AVATAR_PALETTE[paletteIndex(id, AVATAR_PALETTE.length)]
}

export function initialsOf(firstName = '', lastName = '') {
  const first = firstName.trim()[0] || ''
  const last = lastName.trim()[0] || ''
  return `${first}${last}`.toUpperCase() || '??'
}

/** Splits a full name when only that is available (nested request payloads). */
function initialsFromFullName(fullName = '') {
  const parts = fullName.trim().split(/\s+/)
  return initialsOf(parts[0] || '', parts[parts.length - 1] || '')
}

// --- Legal entities -------------------------------------------------------

export function adaptEntity(raw, index = 0) {
  const palette = ENTITY_PALETTE[index % ENTITY_PALETTE.length]
  return {
    id: raw.id,
    code: raw.code,
    name: raw.legalName || raw.name,
    shortName: raw.name,
    country: raw.country?.name ?? '',
    countryCode: raw.country?.code ?? '',
    city: raw.city,
    address: raw.addressLine || `${raw.city}, ${raw.country?.name ?? ''}`,
    currency: raw.currency,
    registration: raw.registrationNumber,
    timeZone: raw.timezone,
    workWeekLabel: raw.workWeekLabel || [],
    weeklyHours: raw.weeklyHours,
    probationMonths: raw.probationMonths,
    noticePeriodDays: raw.noticePeriodDays,
    establishedOn: raw.establishedOn,
    headcount: raw.headcount ?? 0,
    status: raw.isActive ? 'Active' : 'Inactive',
    stats: raw.stats ?? null,
    ...palette,
  }
}

export function adaptEntities(list = []) {
  return list.map(adaptEntity)
}

// --- Employees ------------------------------------------------------------

/**
 * The API returns three progressively richer views of an employee depending on
 * who is asking (`viewLevel`: DIRECTORY, MANAGER or FULL), and restricted fields
 * are absent rather than null. The adapter preserves that: a field the caller
 * may not see stays undefined, and `viewLevel` is carried through so components
 * can hide a whole section instead of rendering empty rows.
 */
export function adaptEmployee(raw) {
  if (!raw) return null

  const address = raw.address
    ? [raw.address.line, raw.address.city, raw.address.country].filter(Boolean).join(', ')
    : undefined

  const emergency = raw.emergencyContact
    ? [raw.emergencyContact.name, raw.emergencyContact.relation].filter(Boolean).join(' · ')
    : undefined

  return {
    id: raw.id,
    employeeNumber: raw.employeeNumber,
    firstName: raw.firstName,
    lastName: raw.lastName,
    fullName: raw.fullName ?? `${raw.firstName} ${raw.lastName}`,
    initials: initialsOf(raw.firstName, raw.lastName),
    color: avatarColor(raw.id),
    avatarUrl: raw.avatarUrl ?? null,

    email: raw.workEmail,
    role: raw.jobTitle,
    department: raw.department?.name ?? 'Unassigned',
    departmentId: raw.department?.id ?? null,

    entityId: raw.legalEntity?.id ?? null,
    entityCode: raw.legalEntity?.code ?? '',
    entityName: raw.legalEntity?.name ?? '',
    currency: raw.legalEntity?.currency ?? '',

    status: EMPLOYEE_STATUS_LABELS[raw.status] ?? raw.status,
    statusValue: raw.status,
    employmentType: EMPLOYMENT_TYPE_LABELS[raw.employmentType] ?? raw.employmentType,
    employmentTypeValue: raw.employmentType,
    workMode: WORK_MODE_LABELS[raw.workMode] ?? raw.workMode,
    // The raw enum alongside the label, matching employmentTypeValue and
    // contractTypeValue. Without it the edit form had no value to bind to and
    // fell back to a hardcoded 'ONSITE', silently overwriting REMOTE/HYBRID on
    // every unrelated save.
    workModeValue: raw.workMode,
    location: raw.workLocation?.name ?? '',

    managerId: raw.manager?.id ?? null,
    managerName: raw.manager?.fullName ?? null,

    // Where and when they work. Location is directory-level; the schedule,
    // calendar and timezone come with MANAGER level and above.
    workLocationId: raw.workLocation?.id ?? null,
    workLocationName: raw.workLocation?.name ?? null,
    workLocationKind: raw.workLocation?.kind ?? null,
    workScheduleId: raw.workSchedule?.id ?? null,
    workScheduleName: raw.workSchedule?.name ?? null,
    holidayCalendarId: raw.holidayCalendar?.id ?? null,
    holidayCalendarName: raw.holidayCalendar?.name ?? null,
    workCountryCode: raw.workCountryCode,
    workCountry: raw.workCountry,
    workCity: raw.workCity,
    timezone: raw.timezone,
    effectiveTimezone: raw.effectiveTimezone,
    overtimeEligible: raw.overtimeEligible,
    attendanceTracked: raw.attendanceTracked,
    capabilities: raw.capabilities ?? null,

    viewLevel: raw.viewLevel ?? 'DIRECTORY',
    directReportCount: raw.directReportCount ?? 0,
    account: raw.account ?? undefined,

    // Present only at MANAGER level and above.
    phone: raw.phone,
    joinDate: raw.hireDate,
    tenureMonths: raw.tenureMonths,
    contractType: CONTRACT_TYPE_LABELS[raw.contractType] ?? raw.contractType,
    contractTypeValue: raw.contractType,
    probationEnd: raw.probationEndDate,
    contractEnd: raw.contractEndDate,
    noticePeriodDays: raw.noticePeriodDays,

    // Present only at FULL level.
    personalEmail: raw.personalEmail,
    dateOfBirth: raw.dateOfBirth,
    gender: raw.gender,
    preferredName: raw.preferredName,
    nationality: raw.nationality,
    address,
    addressLine: raw.address?.line,
    city: raw.address?.city,
    country: raw.address?.country,
    emergencyContact: emergency,
    emergencyContactName: raw.emergencyContact?.name,
    emergencyContactPhone: raw.emergencyContact?.phone,
    emergencyContactRelation: raw.emergencyContact?.relation,
    exitDate: raw.exitDate,
    exitReason: raw.exitReason,
  }
}

export function adaptEmployees(list = []) {
  return list.map(adaptEmployee)
}

/** The compact employee shape embedded in request payloads. */
function adaptNestedEmployee(raw) {
  if (!raw) return null
  return {
    id: raw.id,
    employeeNumber: raw.employeeNumber,
    fullName: raw.fullName,
    initials: initialsFromFullName(raw.fullName),
    color: avatarColor(raw.id),
    role: raw.jobTitle,
    department: raw.department?.name ?? 'Unassigned',
    entityId: raw.legalEntity?.id ?? null,
    entityCode: raw.legalEntity?.code ?? '',
    entityName: raw.legalEntity?.name ?? '',
  }
}

// --- Requests -------------------------------------------------------------

/**
 * Requests are flattened so every card renders from one object regardless of
 * type. The employee is embedded by the API, which removes the directory lookup
 * the mock version needed - and means a request renders correctly even when the
 * viewer cannot list that employee.
 */
export function adaptRequest(raw) {
  if (!raw) return null

  const base = {
    id: raw.id,
    reference: raw.reference,
    type: REQUEST_TYPE_LABELS[raw.type] ?? raw.type,
    typeValue: raw.type,
    status: REQUEST_STATUS_LABELS[raw.status] ?? raw.status,
    statusValue: raw.status,
    submittedAt: raw.submittedAt,
    decidedAt: raw.decidedAt,
    cancelledAt: raw.cancelledAt,
    adminNote: raw.decisionNote ?? '',
    decidedBy: raw.decidedBy?.fullName ?? null,
    employee: adaptNestedEmployee(raw.employee),
    employeeId: raw.employee?.id ?? null,
  }

  if (raw.leave) {
    return {
      ...base,
      subtype: raw.leave.leaveType?.name ?? 'Leave',
      leaveTypeId: raw.leave.leaveType?.id ?? null,
      leaveTypeColor: raw.leave.leaveType?.colorHex ?? '#64748b',
      startDate: raw.leave.startDate,
      endDate: raw.leave.endDate,
      days: raw.leave.workingDays,
      halfDayStart: raw.leave.halfDayStart,
      halfDayEnd: raw.leave.halfDayEnd,
      // Null when the viewer is not entitled to the private reason.
      reason: raw.leave.reason,
      handoverNotes: raw.leave.handoverNotes,
    }
  }

  if (raw.document) {
    return {
      ...base,
      subtype: raw.document.title ?? DOCUMENT_TYPE_LABELS[raw.document.documentType] ?? 'Document',
      documentType: raw.document.documentType,
      purpose: raw.document.purpose,
      addressedTo: raw.document.addressedTo,
      includeSalary: raw.document.includeSalary,
      language: raw.document.language === 'AR' ? 'Arabic' : 'English',
      issuedDocument: raw.document.issuedDocument ?? null,
    }
  }

  if (raw.profileChange) {
    const changes = raw.profileChange.changes ?? []
    return {
      ...base,
      subtype: 'Profile update',
      changes,
      changeCount: raw.profileChange.changeCount ?? changes.length,
      appliedAt: raw.profileChange.appliedAt,
      purpose: Array.isArray(changes) && changes.length
        ? changes.map((change) => change.label).join(', ')
        : plural(raw.profileChange.changeCount ?? 0, 'field'),
    }
  }

  return base
}

export function adaptRequests(list = []) {
  return list.map(adaptRequest)
}

// --- Leave ----------------------------------------------------------------

export function adaptLeaveBalance(raw) {
  return {
    id: raw.id,
    year: raw.year,
    leaveTypeId: raw.leaveType?.id,
    code: raw.leaveType?.code,
    name: raw.leaveType?.name ?? 'Leave',
    color: raw.leaveType?.colorHex ?? '#64748b',
    isPaid: raw.leaveType?.isPaid ?? true,
    allowsHalfDay: raw.leaveType?.allowsHalfDay ?? true,
    entitled: Number(raw.totalEntitlement ?? 0),
    entitledDays: Number(raw.entitledDays ?? 0),
    carriedOverDays: Number(raw.carriedOverDays ?? 0),
    used: Number(raw.usedDays ?? 0),
    pending: Number(raw.pendingDays ?? 0),
    available: Number(raw.availableDays ?? 0),
  }
}

export function adaptLeaveBalances(list = []) {
  return list.map(adaptLeaveBalance)
}

/**
 * Collapses the per-type balances into the single headline pair the employee
 * home screen shows. Annual leave is the number people mean by "days left"; if
 * an entity has no annual type the first paid type stands in.
 */
export function headlineBalance(balances = []) {
  const annual = balances.find((balance) => balance.code === 'ANNUAL')
    ?? balances.find((balance) => balance.isPaid)
    ?? balances[0]

  return {
    available: annual?.available ?? 0,
    used: annual?.used ?? 0,
    pending: annual?.pending ?? 0,
    entitled: annual?.entitled ?? 0,
    name: annual?.name ?? 'Annual leave',
  }
}

// --- Timeline -------------------------------------------------------------

export function adaptTimeline(list = []) {
  return list.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    type: entry.type,
    title: entry.title,
    description: entry.description,
    date: entry.date,
  }))
}

// --- Session --------------------------------------------------------------

const MANAGEMENT_ROLES = new Set(['ADMIN', 'HR_ADMIN'])

/**
 * One shell, navigation by role. ADMIN and HR_ADMIN manage the company;
 * MANAGER gets self-service plus their team; EMPLOYEE gets self-service. The
 * flags only shape the navigation - every rule is enforced by the API.
 */
export function adaptSession(profile) {
  const role = profile.user.role
  return {
    userId: profile.user.id,
    email: profile.user.email,
    role: MANAGEMENT_ROLES.has(role) ? 'admin' : 'employee',
    apiRole: role,
    isManagement: MANAGEMENT_ROLES.has(role),
    isAdmin: role === 'ADMIN',
    isManager: role === 'MANAGER',
    scopedLegalEntityId: profile.user.scopedLegalEntityId ?? null,
    mustChangePassword: profile.user.mustChangePassword,
    employee: profile.employee
      ? {
          id: profile.employee.id,
          employeeNumber: profile.employee.employeeNumber,
          firstName: profile.employee.firstName,
          lastName: profile.employee.lastName,
          fullName: profile.employee.fullName,
          initials: initialsOf(profile.employee.firstName, profile.employee.lastName),
          color: avatarColor(profile.employee.id),
          role: profile.employee.jobTitle,
          status: EMPLOYEE_STATUS_LABELS[profile.employee.status] ?? profile.employee.status,
          department: profile.employee.department?.name ?? 'Unassigned',
          entityId: profile.employee.legalEntity?.id ?? null,
          entityName: profile.employee.legalEntity?.name ?? '',
          currency: profile.employee.legalEntity?.currency ?? '',
          managerName: profile.employee.manager?.fullName ?? null,
          workLocationName: profile.employee.workLocation?.name ?? null,
        }
      : null,
  }
}
