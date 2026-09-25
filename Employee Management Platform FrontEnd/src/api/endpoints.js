/**
 * One function per API operation, each returning already-adapted UI shapes.
 *
 * Components never build a URL or know a backend field name - they call these.
 * List calls return { items, meta, summary } so tables get paging and counts.
 */
import { api, apiRequest, tokenStore } from './client.js'
import {
  adaptEmployee,
  adaptEmployees,
  adaptEntities,
  adaptEntity,
  adaptLeaveBalances,
  adaptRequest,
  adaptRequests,
  adaptSession,
  adaptTimeline,
} from './adapters.js'

const list = (response) => ({
  items: response.data ?? [],
  meta: response.meta ?? null,
  summary: response.summary ?? {},
  totals: response.totals ?? null,
})

// --- Auth -----------------------------------------------------------------

export async function login(email, password) {
  const response = await apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  })
  const payload = response.data
  tokenStore.set({ accessToken: payload.accessToken, refreshToken: payload.refreshToken })
  return adaptSession(payload)
}

/** Restores a session from a stored token on page load. */
export async function fetchProfile() {
  const response = await api.get('/auth/me')
  return adaptSession(response.data)
}

export async function logout() {
  const refreshToken = tokenStore.refresh
  try {
    await apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } })
  } catch {
    // A failed logout must never trap the user in the app; the local tokens are
    // cleared regardless and the server-side session expires on its own.
  } finally {
    tokenStore.clear()
  }
}

export async function changePassword(currentPassword, newPassword) {
  const response = await api.post('/auth/change-password', { currentPassword, newPassword })
  return response.data
}

/** Login-screen branding: product and company name, logo. No auth needed. */
export async function fetchBranding() {
  const response = await apiRequest('/public/branding', { auth: false })
  return response.data
}

// --- Company and reference data ------------------------------------------

export async function fetchCompanySettings() {
  const response = await api.get('/settings/company')
  return response.data
}

export async function updateCompanySettings(payload) {
  const response = await api.patch('/settings/company', payload)
  return response.data
}

/** Kept for the migration: entities still exist internally, one is the company. */
export async function fetchEntities() {
  const response = await api.get('/legal-entities')
  return adaptEntities(response.data)
}

export async function fetchEntity(id) {
  const response = await api.get(`/legal-entities/${id}`)
  return adaptEntity(response.data)
}

export async function fetchDepartments() {
  const response = await api.get('/departments')
  return response.data
}

export const createDepartment = async (payload) => (await api.post('/departments', payload)).data
export const updateDepartment = async (id, payload) => (await api.patch(`/departments/${id}`, payload)).data

export async function fetchWorkLocations(includeInactive = false) {
  const response = await api.get('/work-locations', { includeInactive: includeInactive ? 'true' : undefined })
  return response.data
}
export const createWorkLocation = async (payload) => (await api.post('/work-locations', payload)).data
export const updateWorkLocation = async (id, payload) => (await api.patch(`/work-locations/${id}`, payload)).data
export const fetchWorkforceDistribution = async () => (await api.get('/work-locations/distribution')).data

export async function fetchWorkSchedules(includeInactive = false) {
  const response = await api.get('/work-schedules', { includeInactive: includeInactive ? 'true' : undefined })
  return response.data
}
export const fetchWorkSchedule = async (id) => (await api.get(`/work-schedules/${id}`)).data
export const createWorkSchedule = async (payload) => (await api.post('/work-schedules', payload)).data
export const updateWorkSchedule = async (id, payload) => (await api.patch(`/work-schedules/${id}`, payload)).data
export const assignWorkSchedule = async (id, employeeIds) => (await api.post(`/work-schedules/${id}/assign`, { employeeIds })).data

export const fetchHolidayCalendars = async () => (await api.get('/holiday-calendars')).data
export const createHolidayCalendar = async (payload) => (await api.post('/holiday-calendars', payload)).data
export const updateHolidayCalendar = async (id, payload) => (await api.patch(`/holiday-calendars/${id}`, payload)).data

// --- Employees ------------------------------------------------------------

export async function fetchEmployees(query = {}) {
  const response = await api.get('/employees', {
    q: query.q,
    departmentId: query.departmentId,
    workLocationId: query.workLocationId,
    workMode: query.workMode,
    status: query.status,
    employmentType: query.employmentType,
    managerId: query.managerId,
    includeOffboarded: query.includeOffboarded ? 'true' : undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    page: query.page,
    pageSize: query.pageSize,
  })
  return { items: adaptEmployees(response.data), meta: response.meta }
}

export async function fetchEmployee(id) {
  const response = await api.get(`/employees/${id}`)
  return adaptEmployee(response.data)
}

export async function createEmployee(payload) {
  const response = await api.post('/employees', payload)
  return {
    employee: adaptEmployee(response.data.employee),
    temporaryPassword: response.data.temporaryPassword,
  }
}

export async function updateEmployee(id, payload) {
  const response = await api.patch(`/employees/${id}`, payload)
  return adaptEmployee(response.data)
}

export async function changeEmployeeStatus(id, payload) {
  const response = await api.post(`/employees/${id}/status`, payload)
  return adaptEmployee(response.data)
}

export async function fetchEmployeeTimeline(id) {
  const response = await api.get(`/employees/${id}/timeline`)
  return adaptTimeline(response.data)
}

export async function fetchDirectReports(id) {
  const response = await api.get(`/employees/${id}/reports`)
  return adaptEmployees(response.data)
}

/**
 * Compensation is a separate call on purpose: the API gates it independently,
 * so the UI asks for it only when the Salary tab opens, and a 403 there
 * degrades that one tab rather than the whole profile.
 */
export async function fetchCompensation(id) {
  const response = await api.get(`/employees/${id}/compensation`)
  return response.data
}

export async function addCompensation(id, payload) {
  const response = await api.post(`/employees/${id}/compensation`, payload)
  return response.data
}

export async function fetchEmployeeDocuments(id) {
  const response = await api.get(`/employees/${id}/documents`)
  return response.data
}

export const addEmployeeDocument = async (id, payload) => (await api.post(`/employees/${id}/documents`, payload)).data

export async function fetchEmployeeBalances(id, year) {
  const response = await api.get(`/employees/${id}/leave-balances`, { year })
  return adaptLeaveBalances(response.data)
}

// --- Documents --------------------------------------------------------------

export async function fetchDocuments(query = {}) {
  return list(await api.get('/documents', query))
}

/**
 * Letter body for an issued document. Fetched separately from the document list
 * because the text is large and only wanted when someone opens the letter.
 */
export async function fetchDocumentContent(documentId) {
  const response = await api.get(`/documents/${documentId}`)
  return response.data
}

export const deleteDocument = async (id) => api.delete(`/documents/${id}`)
export const documentDownloadPath = (id) => `/documents/${id}/download`

// --- Requests -------------------------------------------------------------

export async function fetchRequests(query = {}) {
  const response = await api.get('/requests', {
    type: query.type,
    status: query.status,
    employeeId: query.employeeId,
    departmentId: query.departmentId,
    myTeamOnly: query.myTeamOnly ? 'true' : undefined,
    q: query.q,
    page: query.page,
    pageSize: query.pageSize,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  })
  return {
    items: adaptRequests(response.data),
    meta: response.meta,
    summary: response.summary ?? {},
  }
}

export async function fetchRequest(id) {
  const response = await api.get(`/requests/${id}`)
  return adaptRequest(response.data)
}

/** Chargeable days for a date range, from the employee's own schedule and holiday calendar. */
export async function previewLeave(payload) {
  const response = await api.post('/requests/leave/preview', payload)
  return response.data
}

export async function submitLeaveRequest(payload) {
  const response = await api.post('/requests/leave', payload)
  return adaptRequest(response.data)
}

export async function submitDocumentRequest(payload) {
  const response = await api.post('/requests/document', payload)
  return adaptRequest(response.data)
}

export async function submitProfileChangeRequest(changes) {
  const response = await api.post('/requests/profile-change', { changes })
  return adaptRequest(response.data)
}

export async function approveRequest(id, note) {
  const response = await api.post(`/requests/${id}/approve`, { note: note || undefined })
  return adaptRequest(response.data)
}

export async function rejectRequest(id, note) {
  const response = await api.post(`/requests/${id}/reject`, { note })
  return adaptRequest(response.data)
}

export async function cancelRequest(id, note) {
  const response = await api.post(`/requests/${id}/cancel`, { note: note || undefined })
  return adaptRequest(response.data)
}

// --- Leave configuration and balances -----------------------------------

/** Active leave types; `{ includeInactive: true }` also lists retired ones (HR only). */
export async function fetchLeaveTypes(options = {}) {
  const response = await api.get('/leave/types', { includeInactive: options.includeInactive ? 'true' : undefined })
  return response.data
}
export const createLeaveType = async (payload) => (await api.post('/leave/types', payload)).data
export const updateLeaveType = async (id, payload) => (await api.patch(`/leave/types/${id}`, payload)).data

export async function fetchHolidays(query = {}) {
  const response = await api.get('/leave/holidays', { calendarId: query.calendarId, year: query.year })
  return response.data
}
export const createHoliday = async (payload) => (await api.post('/leave/holidays', payload)).data
export const updateHoliday = async (id, payload) => (await api.patch(`/leave/holidays/${id}`, payload)).data
export const deleteHoliday = async (id) => api.delete(`/leave/holidays/${id}`)

export async function fetchLeaveCalendar(from, to) {
  const response = await api.get('/leave/calendar', { from, to })
  return response.data
}

export async function fetchLeaveBalances(query = {}) {
  return list(await api.get('/leave/balances', query))
}
export const adjustLeaveBalance = async (id, payload) => (await api.patch(`/leave/balances/${id}`, payload)).data
export const generateLeaveBalances = async (payload) => (await api.post('/leave/balances/generate', payload)).data

// --- Attendance and overtime ----------------------------------------------

export const checkIn = async (notes) => (await api.post('/attendance/check-in', { notes: notes || undefined })).data
export const checkOut = async (notes) => (await api.post('/attendance/check-out', { notes: notes || undefined })).data
export const fetchAttendanceToday = async () => (await api.get('/attendance/today')).data

export async function fetchAttendance(query = {}) {
  return list(await api.get('/attendance', query))
}
export const fetchAttendanceBoard = async (query = {}) => (await api.get('/attendance/board', query)).data
export const fetchTimesheet = async (query = {}) => (await api.get('/attendance/timesheet', query)).data
export const fetchAttendanceSummary = async (query = {}) => (await api.get('/attendance/summary', query)).data
export const createAttendanceRecord = async (payload) => (await api.post('/attendance', payload)).data
export const correctAttendanceRecord = async (id, payload) => (await api.patch(`/attendance/${id}`, payload)).data
export const recalculateAttendance = async (payload) => (await api.post('/attendance/recalculate', payload)).data
export const fetchMyAttendance = async (query = {}) => (await api.get('/me/attendance', query)).data

export async function fetchOvertime(query = {}) {
  return list(await api.get('/overtime', query))
}
export const createOvertime = async (payload) => (await api.post('/overtime', payload)).data
export const approveOvertime = async (id, note) => (await api.post(`/overtime/${id}/approve`, { note: note || undefined })).data
export const rejectOvertime = async (id, note) => (await api.post(`/overtime/${id}/reject`, { note })).data
export const cancelOvertime = async (id) => (await api.post(`/overtime/${id}/cancel`)).data

// --- Salary advances ----------------------------------------------------------

export async function fetchAdvances(query = {}) {
  return list(await api.get('/advances', query))
}
export const fetchAdvance = async (id) => (await api.get(`/advances/${id}`)).data
export const requestAdvance = async (payload) => (await api.post('/advances', payload)).data
export const approveAdvance = async (id, payload) => (await api.post(`/advances/${id}/approve`, payload)).data
export const rejectAdvance = async (id, note) => (await api.post(`/advances/${id}/reject`, { note })).data
export const markAdvancePaid = async (id, payload) => (await api.post(`/advances/${id}/mark-paid`, payload)).data
export const rescheduleAdvance = async (id, payload) => (await api.post(`/advances/${id}/reschedule`, payload)).data
export const cancelAdvance = async (id) => (await api.post(`/advances/${id}/cancel`)).data

// --- Payroll ----------------------------------------------------------------------

export const fetchPayrollPeriods = async (query = {}) => (await api.get('/payroll/periods', query)).data
export const createPayrollPeriod = async (payload) => (await api.post('/payroll/periods', payload)).data
export const fetchPayrollPeriod = async (id) => (await api.get(`/payroll/periods/${id}`)).data
export const calculatePayrollPeriod = async (id) => (await api.post(`/payroll/periods/${id}/calculate`)).data
export const reviewPayrollPeriod = async (id) => (await api.post(`/payroll/periods/${id}/review`)).data
export const approvePayrollPeriod = async (id) => (await api.post(`/payroll/periods/${id}/approve`)).data
export const markPayrollPaid = async (id, payload) => (await api.post(`/payroll/periods/${id}/mark-paid`, payload)).data
export const reopenPayrollPeriod = async (id, reason) => (await api.post(`/payroll/periods/${id}/reopen`, { reason })).data
export const cancelPayrollPeriod = async (id, reason) => (await api.post(`/payroll/periods/${id}/cancel`, { reason: reason || undefined })).data
export const fetchPayrollRecord = async (id) => (await api.get(`/payroll/records/${id}`)).data

export async function fetchAdjustments(query = {}) {
  return list(await api.get('/payroll/adjustments', query))
}
export const createAdjustment = async (payload) => (await api.post('/payroll/adjustments', payload)).data
export const approveAdjustment = async (id, note) => (await api.post(`/payroll/adjustments/${id}/approve`, { note: note || undefined })).data
export const rejectAdjustment = async (id, note) => (await api.post(`/payroll/adjustments/${id}/reject`, { note })).data
export const cancelAdjustment = async (id) => (await api.post(`/payroll/adjustments/${id}/cancel`)).data

export const fetchPayslips = async (query = {}) => (await api.get('/payslips', query)).data
export const payslipPdfPath = (recordId) => `/payslips/${recordId}/pdf`

// --- Reports ------------------------------------------------------------------------

export const fetchReportCatalog = async () => (await api.get('/reports')).data
export const runReport = async (type, query = {}) => (await api.get(`/reports/${type}`, { ...query, format: 'json' })).data
export const reportPath = (type) => `/reports/${type}`

// --- Users & roles ------------------------------------------------------------------

export async function fetchUsers(query = {}) {
  return list(await api.get('/users', query))
}
export const fetchEligibleEmployees = async () => (await api.get('/users/eligible-employees')).data
export const createUser = async (payload) => (await api.post('/users', payload)).data
export const updateUser = async (id, payload) => (await api.patch(`/users/${id}`, payload)).data
export const resetUserPassword = async (id) => (await api.post(`/users/${id}/reset-password`, {})).data
export const unlockUser = async (id) => (await api.post(`/users/${id}/unlock`)).data

// --- Self-service ---------------------------------------------------------

export async function fetchMyProfile() {
  const response = await api.get('/me/profile')
  return adaptEmployee(response.data)
}

export async function fetchMyBalances(year) {
  const response = await api.get('/me/leave-balances', { year })
  return adaptLeaveBalances(response.data)
}

export async function fetchMyRequests(query = {}) {
  const response = await api.get('/me/requests', {
    status: query.status,
    type: query.type,
    pageSize: query.pageSize ?? 50,
    page: query.page,
  })
  return { items: adaptRequests(response.data), meta: response.meta, summary: response.summary ?? {} }
}

export async function fetchMyDocuments() {
  const response = await api.get('/me/documents')
  return response.data
}

export async function fetchMyTimeline() {
  const response = await api.get('/me/timeline')
  return adaptTimeline(response.data)
}

/**
 * A manager's direct reports, resolved from the token rather than from an id in
 * the URL. The API returns them at MANAGER view level: working context, never
 * compensation.
 */
export async function fetchMyTeam() {
  const response = await api.get('/me/team')
  return adaptEmployees(response.data)
}

// --- Dashboard, notifications and audit -----------------------------------

export async function fetchDashboard() {
  const response = await api.get('/dashboard')
  return response.data
}

export async function fetchCompensationOverview() {
  const response = await api.get('/dashboard/compensation-overview')
  return response.data
}

export async function fetchNotifications(unreadOnly = false) {
  const response = await api.get('/notifications', {
    unreadOnly: unreadOnly ? 'true' : undefined,
    pageSize: 20,
  })
  return { items: response.data, unreadCount: response.unreadCount ?? 0 }
}

export async function markAllNotificationsRead() {
  const response = await api.post('/notifications/read-all')
  return response.data
}

export async function markNotificationRead(id) {
  const response = await api.post(`/notifications/${id}/read`)
  return response.data
}

export async function fetchAuditLogs(query = {}) {
  return list(await api.get('/audit-logs', { pageSize: 25, ...query }))
}
