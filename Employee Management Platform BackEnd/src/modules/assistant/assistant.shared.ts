import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AppError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { entityScopeWhere, isManagement } from '../../services/access';
import type { AuditInput } from '../../services/audit.service';
import type { ReportDocument } from '../reports/report.export';
import { fullName } from '../employees/employee.serializer';

/** What every assistant tool shares: its shape, its context, and name lookups. */

export type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Something the assistant prepared for the person to confirm - it is never
 * carried out by the assistant itself. The page shows it as a card, and
 * confirming calls the ordinary endpoint, with its ordinary checks.
 */
export interface ProposedAction {
  type: 'create_task' | 'decide_request';
  /** One line for the card, e.g. "Task for Daniel Mathew". */
  title: string;
  details: { label: string; value: string }[];
  payload: Record<string, unknown>;
}

export interface ToolContext {
  auth: AuthContext;
  fingerprint: Fingerprint;
  now: Date;
  /** Where action tools leave what they prepared, for the page to show. */
  actions: ProposedAction[];
}

export interface AssistantTool {
  name: string;
  /** Shown under an answer: where it came from. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Who is offered the tool at all. The service behind it checks again. */
  forRole: 'ALL' | 'MANAGEMENT';
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

export const MAX_ROWS = 120;

export const date = (description: string) => ({ type: 'string', description: `${description} (YYYY-MM-DD)` });
export const PERSON = { type: 'string', description: 'Part of one person’s name, e.g. "Ahmed" or "Layla Mansour". Leave out for everyone.' };
export const DEPARTMENT = { type: 'string', description: 'Part of a department name, e.g. "Sales". Leave out for every department.' };

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A thrown refusal or validation error goes back to the model as data it can explain. */
export function toolError(error: unknown): { error: string } {
  if (error instanceof AppError) {
    const details = error.details && typeof error.details === 'object' ? Object.values(error.details).flat().join(' ') : '';
    return { error: [error.message, details].filter(Boolean).join(': ') };
  }
  throw error;
}

/** The people a caller may ask about: HR their scope, a manager themselves and their reports. */
export function reachWhere(auth: AuthContext): Prisma.EmployeeWhereInput {
  if (isManagement(auth)) return entityScopeWhere(auth);
  if (!auth.employeeId) return { id: { in: [] } };
  return { OR: [{ id: auth.employeeId }, { managerId: auth.employeeId }] };
}

/**
 * Turns a name the model passed into one employee id, within the caller's
 * reach. Several matches come back as candidates for the model to ask about.
 */
export async function resolvePerson(auth: AuthContext, name: string) {
  const words = name.split(/\s+/).filter(Boolean).slice(0, 4);
  const people = await prisma.employee.findMany({
    where: {
      AND: [
        reachWhere(auth),
        ...words.map((word) => ({
          OR: [
            { firstName: { contains: word, mode: 'insensitive' as const } },
            { lastName: { contains: word, mode: 'insensitive' as const } },
            { preferredName: { contains: word, mode: 'insensitive' as const } },
            { employeeNumber: { equals: word, mode: 'insensitive' as const } },
          ],
        })),
      ],
    },
    select: { id: true, firstName: true, lastName: true, preferredName: true, jobTitle: true },
    take: 6,
  });
  if (people.length === 1) return { id: people[0]!.id };
  if (people.length === 0) return { error: `Nobody called "${name}" is among the people you can see.` };
  return { error: `"${name}" matches several people - ask which one.`, candidates: people.map((person) => `${fullName(person)} (${person.jobTitle})`) };
}

export async function resolveDepartment(name: string) {
  const departments = await prisma.department.findMany({
    where: { name: { contains: name, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 5,
  });
  if (departments.length === 1) return { id: departments[0]!.id };
  if (departments.length === 0) {
    const all = await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    return { error: `No department matches "${name}".`, departments: all.map((department) => department.name) };
  }
  return { error: `"${name}" matches several departments.`, departments: departments.map((department) => department.name) };
}

/** Name filters to ids; a failed lookup is returned to the model instead of a report. */
export async function filters(auth: AuthContext, args: Record<string, unknown>) {
  const result: { employeeId?: string; departmentId?: string } = {};
  const person = text(args.person);
  if (person) {
    const found = await resolvePerson(auth, person);
    if ('error' in found) return { failed: found };
    result.employeeId = found.id;
  }
  const department = text(args.department);
  if (department) {
    const found = await resolveDepartment(department);
    if ('error' in found) return { failed: found };
    result.departmentId = found.id;
  }
  return { result };
}

/** A report as compact rows: column labels once, then plain values, capped. */
export function compactReport(document: ReportDocument) {
  return {
    title: document.title,
    period: document.subtitle,
    columns: document.columns.map((column) => column.label),
    rows: document.rows.slice(0, MAX_ROWS).map((row) => document.columns.map((column) => row[column.key] ?? null)),
    totalRows: document.rows.length,
    ...(document.rows.length > MAX_ROWS ? { note: `Only the first ${MAX_ROWS} rows are shown.` } : {}),
    totals: document.summary,
  };
}
