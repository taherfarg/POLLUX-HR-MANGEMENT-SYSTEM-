import type { Prisma } from '@prisma/client';
import type { AuthContext } from '../../common/auth-context';
import { employeeViewLevel, type EmployeeCapabilities, type EmployeeViewLevel } from '../../services/access';
import { monthsBetween } from '../../services/working-days';

/**
 * Serializers are the last line of the privacy design.
 *
 * Access checks decide whether a caller may load a record at all; these
 * functions decide which fields come back once they can. Building the response
 * by naming fields explicitly - never by spreading the Prisma row - means a
 * column added to the schema later cannot leak by default.
 */

export const employeeListInclude = {
  legalEntity: { select: { id: true, code: true, name: true, countryCode: true, currency: true, timezone: true } },
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
  workLocation: { select: { id: true, code: true, name: true, kind: true, timezone: true } },
} satisfies Prisma.EmployeeInclude;

export const employeeDetailInclude = {
  ...employeeListInclude,
  workSchedule: { select: { id: true, code: true, name: true, timezone: true } },
  holidayCalendar: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, email: true, role: true, isActive: true, lastLoginAt: true } },
  _count: { select: { directReports: true } },
} satisfies Prisma.EmployeeInclude;

export type EmployeeListRow = Prisma.EmployeeGetPayload<{ include: typeof employeeListInclude }>;
export type EmployeeDetailRow = Prisma.EmployeeGetPayload<{ include: typeof employeeDetailInclude }>;

export function fullName(employee: { firstName: string; lastName: string; preferredName?: string | null }): string {
  return `${employee.preferredName ?? employee.firstName} ${employee.lastName}`;
}

/** Whole months of service, used for tenure reporting and probation tracking. */
export function tenureMonths(hireDate: Date, exitDate: Date | null): number {
  return Math.max(0, monthsBetween(hireDate, exitDate ?? new Date()));
}

function toDateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * The company address book. Every authenticated user may see this much about a
 * colleague: enough to find and contact them, nothing personal.
 */
function directoryView(employee: EmployeeListRow) {
  return {
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    preferredName: employee.preferredName,
    fullName: fullName(employee),
    workEmail: employee.workEmail,
    jobTitle: employee.jobTitle,
    status: employee.status,
    employmentType: employee.employmentType,
    workMode: employee.workMode,
    avatarUrl: employee.avatarUrl,
    department: employee.department,
    legalEntity: {
      id: employee.legalEntity.id,
      code: employee.legalEntity.code,
      name: employee.legalEntity.name,
      countryCode: employee.legalEntity.countryCode,
      currency: employee.legalEntity.currency,
    },
    workLocation: employee.workLocation
      ? { id: employee.workLocation.id, code: employee.workLocation.code, name: employee.workLocation.name, kind: employee.workLocation.kind }
      : null,
    manager: employee.manager
      ? { id: employee.manager.id, fullName: `${employee.manager.firstName} ${employee.manager.lastName}` }
      : null,
  };
}

/** The zone the employee works in, after the fallbacks. */
export function effectiveTimezone(employee: EmployeeListRow): string {
  return employee.timezone ?? employee.workLocation?.timezone ?? employee.legalEntity.timezone;
}

/**
 * A line manager additionally gets working context - start date, contract shape,
 * work phone - which they need to plan around their team. Still no date of
 * birth, home address, nationality or compensation.
 */
function managerView(employee: EmployeeListRow) {
  return {
    ...directoryView(employee),
    phone: employee.phone,
    hireDate: toDateOnly(employee.hireDate),
    tenureMonths: tenureMonths(employee.hireDate, employee.exitDate),
    contractType: employee.contractType,
    probationEndDate: toDateOnly(employee.probationEndDate),
    contractEndDate: toDateOnly(employee.contractEndDate),
    noticePeriodDays: employee.noticePeriodDays,
    // Where a report works matters for planning a team across timezones. For a
    // remote employee the city is effectively where they live, so it starts at
    // manager level rather than in the address book.
    workCountryCode: employee.workCountryCode,
    workCountry: employee.workCountry,
    workCity: employee.workCity,
    timezone: employee.timezone,
    effectiveTimezone: effectiveTimezone(employee),
  };
}

/** HR, an administrator in scope, or the employee themselves. */
function fullView(employee: EmployeeListRow) {
  return {
    ...managerView(employee),
    personalEmail: employee.personalEmail,
    dateOfBirth: toDateOnly(employee.dateOfBirth),
    gender: employee.gender,
    nationality: employee.nationality,
    address: {
      line: employee.addressLine,
      city: employee.city,
      country: employee.country,
    },
    emergencyContact: employee.emergencyContactName
      ? {
          name: employee.emergencyContactName,
          phone: employee.emergencyContactPhone,
          relation: employee.emergencyContactRelation,
        }
      : null,
    exitDate: toDateOnly(employee.exitDate),
    exitReason: employee.exitReason,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
}

export function serializeEmployee(
  employee: EmployeeListRow,
  level: EmployeeViewLevel,
): Record<string, unknown> {
  switch (level) {
    case 'FULL':
      return { ...fullView(employee), viewLevel: level };
    case 'MANAGER':
      return { ...managerView(employee), viewLevel: level };
    default:
      return { ...directoryView(employee), viewLevel: level };
  }
}

/** Serializes a list, resolving the caller's permission for each row separately. */
export function serializeEmployeeList(
  employees: EmployeeListRow[],
  auth: AuthContext,
): Record<string, unknown>[] {
  return employees.map((employee) => serializeEmployee(employee, employeeViewLevel(auth, employee)));
}

export function serializeEmployeeDetail(
  employee: EmployeeDetailRow,
  level: EmployeeViewLevel,
  options: { includeAccount: boolean; capabilities?: EmployeeCapabilities },
): Record<string, unknown> {
  const base = serializeEmployee(employee, level);
  return {
    ...base,
    // Schedule and holiday calendar are working context (MANAGER and up);
    // overtime eligibility is an HR employment term (FULL only).
    ...(level === 'DIRECTORY'
      ? {}
      : {
          workSchedule: employee.workSchedule,
          holidayCalendar: employee.holidayCalendar,
        }),
    ...(level === 'FULL' ? { overtimeEligible: employee.overtimeEligible } : {}),
    directReportCount: employee._count.directReports,
    capabilities: options.capabilities,
    // The linked login account is management information, not part of the
    // employee's own profile view.
    account: options.includeAccount
      ? employee.user
        ? {
            id: employee.user.id,
            email: employee.user.email,
            role: employee.user.role,
            isActive: employee.user.isActive,
            lastLoginAt: employee.user.lastLoginAt,
          }
        : null
      : undefined,
  };
}
