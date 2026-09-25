import type { Prisma } from '@prisma/client';
import type { AuthContext } from '../common/auth-context';
import { ForbiddenError } from '../common/errors';

/**
 * Every authorization decision in the API is made by a function in this file.
 *
 * Keeping them together means the privacy rules can be read in one sitting and
 * tested directly, instead of being spread across controllers where a missing
 * check is invisible.
 */

/** ADMIN and HR_ADMIN both manage people; they differ only in entity scope. */
export function isManagement(auth: AuthContext): boolean {
  return auth.role === 'ADMIN' || auth.role === 'HR_ADMIN';
}

/** A global ADMIN sees every legal entity; an HR_ADMIN may be pinned to one. */
export function scopedEntityId(auth: AuthContext): string | null {
  if (auth.role === 'ADMIN') return null;
  return auth.scopedLegalEntityId;
}

/**
 * Prisma `where` fragment restricting a query to the entities the caller may
 * see. Spread into any employee/request query that management can run.
 */
export function entityScopeWhere(auth: AuthContext): Prisma.EmployeeWhereInput {
  const entityId = scopedEntityId(auth);
  return entityId ? { legalEntityId: entityId } : {};
}

export function assertEntityInScope(auth: AuthContext, legalEntityId: string): void {
  const entityId = scopedEntityId(auth);
  if (entityId && entityId !== legalEntityId) {
    throw new ForbiddenError('This record belongs to a legal entity outside your access scope');
  }
}

/** The shape any authorization check needs from an employee row. */
export interface EmployeeAccessSubject {
  id: string;
  legalEntityId: string;
  managerId: string | null;
}

export function isSelf(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return auth.employeeId !== null && auth.employeeId === employee.id;
}

export function isDirectManagerOf(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return auth.employeeId !== null && employee.managerId === auth.employeeId;
}

/** HR or an administrator whose scope covers this employee. */
export function managesEmployee(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  if (!isManagement(auth)) return false;
  const entityId = scopedEntityId(auth);
  return entityId === null || entityId === employee.legalEntityId;
}

/**
 * How much of an employee record the caller is allowed to see.
 *
 *  FULL      - HR/admin within scope, or the employee themselves.
 *  MANAGER   - a direct manager: work context and contact details, no personal
 *              identity data and never compensation.
 *  DIRECTORY - any authenticated colleague: the same information a company
 *              address book would show. Real HRIS products do this, and it is
 *              far more useful than hiding colleagues entirely.
 */
export type EmployeeViewLevel = 'FULL' | 'MANAGER' | 'DIRECTORY';

export function employeeViewLevel(auth: AuthContext, employee: EmployeeAccessSubject): EmployeeViewLevel {
  if (isSelf(auth, employee) || managesEmployee(auth, employee)) return 'FULL';
  if (isDirectManagerOf(auth, employee)) return 'MANAGER';
  return 'DIRECTORY';
}

/**
 * Compensation is the most sensitive data in the system. Only HR/admin within
 * scope and the employee themselves may read it - explicitly not the line
 * manager, who can otherwise see most of the record.
 */
export function canViewCompensation(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return isSelf(auth, employee) || managesEmployee(auth, employee);
}

export function assertCanViewCompensation(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!canViewCompensation(auth, employee)) {
    throw new ForbiddenError('Compensation details are restricted to HR and the employee');
  }
}

/** Only HR/admin may change compensation - an employee cannot edit their own. */
export function assertCanEditCompensation(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!managesEmployee(auth, employee)) {
    throw new ForbiddenError('Only HR can record a compensation change');
  }
}

export function canEditEmployee(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return managesEmployee(auth, employee);
}

export function assertCanEditEmployee(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!canEditEmployee(auth, employee)) {
    throw new ForbiddenError('Only HR can edit employee records');
  }
}

/**
 * Personal identity data - date of birth, home address, nationality, emergency
 * contact - is visible to HR within scope and to the employee only.
 */
export function assertCanViewPersonalData(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!isSelf(auth, employee) && !managesEmployee(auth, employee)) {
    throw new ForbiddenError('You do not have access to this employee record');
  }
}

/**
 * Documents can hold passports and contracts, so the rule is stricter than the
 * directory: HR within scope, or the employee themselves. Records flagged
 * confidential are additionally hidden from the employee.
 */
export function assertCanViewDocuments(auth: AuthContext, employee: EmployeeAccessSubject): void {
  assertCanViewPersonalData(auth, employee);
}

export function canViewConfidentialDocuments(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return managesEmployee(auth, employee);
}

/** A request is visible to its owner, the owner's manager, and HR within scope. */
export function canViewRequest(
  auth: AuthContext,
  request: { employeeId: string; legalEntityId: string },
  requesterManagerId: string | null,
): boolean {
  const subject: EmployeeAccessSubject = {
    id: request.employeeId,
    legalEntityId: request.legalEntityId,
    managerId: requesterManagerId,
  };
  return isSelf(auth, subject) || managesEmployee(auth, subject) || isDirectManagerOf(auth, subject);
}

/**
 * Approving is narrower than viewing: HR within scope, or the requester's direct
 * manager. Nobody may decide their own request, including an admin - the
 * four-eyes rule that keeps the audit trail meaningful.
 */
export function assertCanDecideRequest(
  auth: AuthContext,
  request: { employeeId: string; legalEntityId: string },
  requesterManagerId: string | null,
): void {
  const subject: EmployeeAccessSubject = {
    id: request.employeeId,
    legalEntityId: request.legalEntityId,
    managerId: requesterManagerId,
  };

  if (isSelf(auth, subject)) {
    throw new ForbiddenError('You cannot approve or reject your own request');
  }
  if (!managesEmployee(auth, subject) && !isDirectManagerOf(auth, subject)) {
    throw new ForbiddenError('Only HR or the direct manager can decide this request');
  }
}

export function assertIsManagement(auth: AuthContext): void {
  if (!isManagement(auth)) {
    throw new ForbiddenError('This action is restricted to HR and administrators');
  }
}

/**
 * Withdrawing a pending request: the employee who filed it, or HR within scope.
 * Before this rule existed any management user could cancel any request,
 * including one in an entity outside their scope.
 */
export function assertCanCancelRequest(
  auth: AuthContext,
  request: { employeeId: string; legalEntityId: string },
): void {
  const subject: EmployeeAccessSubject = { id: request.employeeId, legalEntityId: request.legalEntityId, managerId: null };
  if (!isSelf(auth, subject) && !managesEmployee(auth, subject)) {
    throw new ForbiddenError('Only the employee who submitted this request, or HR, can withdraw it');
  }
}

// ---------------------------------------------------------------------------
// Pollux HR: administration
// ---------------------------------------------------------------------------

export function isAdmin(auth: AuthContext): boolean {
  return auth.role === 'ADMIN';
}

export function assertIsAdmin(auth: AuthContext, action = 'This action'): void {
  if (!isAdmin(auth)) {
    throw new ForbiddenError(`${action} is restricted to administrators`);
  }
}

/**
 * Who may hand out which role.
 *
 * Granting ADMIN or HR_ADMIN is a global act reserved for a global ADMIN. An HR
 * admin may create EMPLOYEE and MANAGER logins only - without this, a scoped HR
 * admin could mint an ADMIN account through employee creation and step outside
 * their own scope. An entity scope is only meaningful on an HR_ADMIN.
 */
export function assertCanAssignRole(
  auth: AuthContext,
  role: 'ADMIN' | 'HR_ADMIN' | 'MANAGER' | 'EMPLOYEE',
  scopedLegalEntityId?: string | null,
): void {
  assertIsManagement(auth);
  if ((role === 'ADMIN' || role === 'HR_ADMIN') && !isAdmin(auth)) {
    throw new ForbiddenError('Only an administrator can grant the ADMIN or HR_ADMIN role');
  }
  if (scopedLegalEntityId && role !== 'HR_ADMIN') {
    throw new ForbiddenError('An entity scope can only be set on an HR_ADMIN account');
  }
}

/** Company settings shape every calculation, so only an ADMIN may change them. */
export function assertCanManageCompanySettings(auth: AuthContext): void {
  assertIsAdmin(auth, 'Changing company settings');
}

/** Management may only act on configuration belonging to an entity in scope. */
export function assertCanManageEntityConfig(auth: AuthContext, legalEntityId: string): void {
  assertIsManagement(auth);
  assertEntityInScope(auth, legalEntityId);
}

/**
 * Audit entries an HR admin may read. A scoped HR admin only sees entries
 * tagged with their own entity - the trail carries salary before/after values,
 * so an unscoped view would leak other entities' pay.
 */
export function auditScopeWhere(auth: AuthContext): Prisma.AuditLogWhereInput {
  const entityId = scopedEntityId(auth);
  return entityId ? { legalEntityId: entityId } : {};
}

// ---------------------------------------------------------------------------
// Pollux HR: attendance
// ---------------------------------------------------------------------------

/**
 * Attendance is working context, not pay: the employee, their direct manager
 * and HR within scope may read it.
 */
export function canViewAttendance(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return isSelf(auth, employee) || managesEmployee(auth, employee) || isDirectManagerOf(auth, employee);
}

export function assertCanViewAttendance(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!canViewAttendance(auth, employee)) {
    throw new ForbiddenError('You do not have access to this attendance record');
  }
}

/** Creating or correcting someone's attendance is an HR act, never self-service. */
export function canManageAttendance(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return managesEmployee(auth, employee);
}

export function assertCanManageAttendance(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!canManageAttendance(auth, employee)) {
    throw new ForbiddenError('Only HR can create or correct attendance records');
  }
}

// ---------------------------------------------------------------------------
// Pollux HR: pay - payroll, payslips, advances, adjustments
// ---------------------------------------------------------------------------

/**
 * Anything that reveals what someone is paid - payslips, payroll lines,
 * advances, overtime amounts - follows the compensation rule: the employee
 * themselves and HR within scope. A line manager is deliberately excluded.
 */
export function canViewPayData(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return canViewCompensation(auth, employee);
}

export function assertCanViewPayData(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (!canViewPayData(auth, employee)) {
    throw new ForbiddenError('Pay information is restricted to HR and the employee');
  }
}

/** Running payroll for an entity: HR or an administrator within scope. */
export function assertCanManagePayroll(auth: AuthContext, legalEntityId: string): void {
  if (!isManagement(auth)) {
    throw new ForbiddenError('Payroll is restricted to HR and administrators');
  }
  assertEntityInScope(auth, legalEntityId);
}

/** Only an ADMIN may reopen an approved payroll - it unlocks financial records. */
export function assertCanReopenPayroll(auth: AuthContext, legalEntityId: string): void {
  assertIsAdmin(auth, 'Reopening an approved payroll');
  assertEntityInScope(auth, legalEntityId);
}

/**
 * Deciding a salary advance moves money, so it is HR within scope - never the
 * line manager, and never the employee deciding their own.
 */
export function assertCanDecideAdvance(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (isSelf(auth, employee)) {
    throw new ForbiddenError('You cannot decide your own salary advance');
  }
  if (!managesEmployee(auth, employee)) {
    throw new ForbiddenError('Only HR can decide salary advances');
  }
}

// ---------------------------------------------------------------------------
// Pollux HR: overtime
// ---------------------------------------------------------------------------

/** Overtime minutes are working context, like attendance. */
export function canViewOvertime(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return canViewAttendance(auth, employee);
}

/** Overtime *amounts* are pay, so a line manager sees minutes only. */
export function canViewOvertimeAmounts(auth: AuthContext, employee: EmployeeAccessSubject): boolean {
  return canViewPayData(auth, employee);
}

/**
 * Approving overtime minutes: HR within scope or the direct manager, and
 * nobody decides their own.
 */
export function assertCanDecideOvertime(auth: AuthContext, employee: EmployeeAccessSubject): void {
  if (isSelf(auth, employee)) {
    throw new ForbiddenError('You cannot approve your own overtime');
  }
  if (!managesEmployee(auth, employee) && !isDirectManagerOf(auth, employee)) {
    throw new ForbiddenError('Only HR or the direct manager can decide this overtime');
  }
}

/**
 * What the caller may do with one employee's record. Returned to the UI so it
 * can decide which profile tabs to show - the API still enforces every rule on
 * the underlying endpoints, so this is a hint, never a permission.
 */
export function employeeCapabilities(auth: AuthContext, employee: EmployeeAccessSubject) {
  return {
    canEdit: canEditEmployee(auth, employee),
    canViewPersonal: isSelf(auth, employee) || managesEmployee(auth, employee),
    canViewCompensation: canViewCompensation(auth, employee),
    canViewPayData: canViewPayData(auth, employee),
    canViewAttendance: canViewAttendance(auth, employee),
    canManageAttendance: canManageAttendance(auth, employee),
    canViewLeave: isSelf(auth, employee) || isManagement(auth) || isDirectManagerOf(auth, employee),
    canViewDocuments: isSelf(auth, employee) || managesEmployee(auth, employee),
    canViewTimeline: isSelf(auth, employee) || managesEmployee(auth, employee),
  };
}

export type EmployeeCapabilities = ReturnType<typeof employeeCapabilities>;
