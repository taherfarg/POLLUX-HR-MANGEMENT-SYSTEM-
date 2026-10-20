import type { Prisma, TaskStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { buildPageMeta, paginationSchema, toSkipTake, type PageMeta } from '../../common/http';
import {
  dateStringSchema,
  optionalTrimmedString,
  requiredTrimmedString,
  toUtcDate,
} from '../../common/validate';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import {
  assertCanAssignTaskTo,
  assertIsManagement,
  canEditTask,
  canProgressTask,
  canViewTask,
  entityScopeWhere,
  isManagement,
  isSelf,
  scopedEntityId,
  type TaskAccessSubject,
} from '../../services/access';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { notifyEmployee, notifyUser } from '../../services/notification.service';
import { findPrimaryLegalEntityId } from '../../services/company';
import { zonedDateKey } from '../../services/timezone';
import { toDateKey } from '../../services/working-days';
import { fullName } from '../employees/employee.serializer';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const OPEN_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS'];

/** A due date may be cleared: `""` and `null` both mean "no due date". */
const optionalDueDate = z
  .union([dateStringSchema, z.literal(''), z.null()])
  .transform((value) => (value ? value : null))
  .optional();

export const taskCreateSchema = z.object({
  title: requiredTrimmedString(3, 160),
  description: optionalTrimmedString(4000),
  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
  dueDate: optionalDueDate,
  /** Omitted: a task for yourself. */
  assigneeId: optionalTrimmedString(40),
});

export const taskUpdateSchema = z
  .object({
    title: requiredTrimmedString(3, 160).optional(),
    description: z
      .union([z.string().trim().max(4000), z.null()])
      .transform((value) => (value ? value : null))
      .optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueDate: optionalDueDate,
    assigneeId: z.string().trim().min(1).max(40).optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Nothing to change');

export const taskCommentSchema = z.object({ body: requiredTrimmedString(1, 2000) });

export const taskQuerySchema = paginationSchema.extend({
  /**
   * mine    - given to me
   * created - given by me, to anyone
   * team    - given to my direct reports, by anyone
   * all     - every task in scope (HR and administrators)
   */
  view: z.enum(['mine', 'created', 'team', 'all']).default('mine'),
  status: z.enum(['open', 'all', ...TASK_STATUSES]).default('open'),
  q: optionalTrimmedString(100),
  assigneeId: optionalTrimmedString(40),
});

export const assigneeQuerySchema = z.object({ q: optionalTrimmedString(100) });

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;

const personSelect = {
  id: true,
  firstName: true,
  lastName: true,
  preferredName: true,
  employeeNumber: true,
  jobTitle: true,
  legalEntityId: true,
  managerId: true,
} satisfies Prisma.EmployeeSelect;

const userNameSelect = {
  id: true,
  email: true,
  employee: { select: { firstName: true, lastName: true, preferredName: true } },
} satisfies Prisma.UserSelect;

const taskInclude = {
  assignee: { select: personSelect },
  createdBy: { select: userNameSelect },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type UserName = Prisma.UserGetPayload<{ select: typeof userNameSelect }>;

function userName(user: UserName): string {
  return user.employee ? fullName(user.employee) : user.email;
}

function accessSubject(task: TaskRow): TaskAccessSubject {
  return { createdById: task.createdById, assignee: task.assignee };
}

/**
 * Today in the caller's office timezone: a task due today is not overdue in
 * Dubai just because it is already tomorrow in UTC.
 */
async function todayKeyFor(auth: AuthContext): Promise<string> {
  const entityId = auth.legalEntityId ?? (await findPrimaryLegalEntityId());
  const entity = entityId
    ? await prisma.legalEntity.findUnique({ where: { id: entityId }, select: { timezone: true } })
    : null;
  return zonedDateKey(new Date(), entity?.timezone ?? 'UTC');
}

function serializeTask(task: TaskRow, auth: AuthContext, todayKey: string) {
  const subject = accessSubject(task);
  const dueDate = task.dueDate ? toDateKey(task.dueDate) : null;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate,
    isOverdue: dueDate !== null && OPEN_STATUSES.includes(task.status) && dueDate < todayKey,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    assignee: {
      id: task.assignee.id,
      fullName: fullName(task.assignee),
      employeeNumber: task.assignee.employeeNumber,
      jobTitle: task.assignee.jobTitle,
    },
    createdBy: task.createdBy ? { id: task.createdBy.id, fullName: userName(task.createdBy) } : null,
    commentCount: task._count.comments,
    permissions: {
      canEdit: canEditTask(auth, subject),
      canProgress: canProgressTask(auth, subject),
      isAssignee: isSelf(auth, task.assignee),
    },
  };
}

/** Loads a task the caller may see. Someone else's task reads as not found. */
async function loadVisibleTask(auth: AuthContext, id: string): Promise<TaskRow> {
  const task = await prisma.task.findUnique({ where: { id }, include: taskInclude });
  if (!task || !canViewTask(auth, accessSubject(task))) {
    throw new NotFoundError('Task');
  }
  return task;
}

async function callerName(auth: AuthContext): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: userNameSelect });
  return user ? userName(user) : auth.email;
}

const NOTHING: Prisma.TaskWhereInput = { id: { in: [] } };

function viewWhere(auth: AuthContext, view: TaskQuery['view']): Prisma.TaskWhereInput {
  switch (view) {
    case 'mine':
      return auth.employeeId ? { assigneeId: auth.employeeId } : NOTHING;
    case 'created':
      return { createdById: auth.userId };
    case 'team':
      return auth.employeeId ? { assignee: { managerId: auth.employeeId } } : NOTHING;
    case 'all': {
      assertIsManagement(auth);
      const entityId = scopedEntityId(auth);
      return entityId ? { legalEntityId: entityId } : {};
    }
  }
}

function statusWhere(status: TaskQuery['status']): Prisma.TaskWhereInput {
  if (status === 'all') return {};
  if (status === 'open') return { status: { in: OPEN_STATUSES } };
  return { status };
}

export async function listTasks(
  auth: AuthContext,
  query: TaskQuery,
): Promise<{
  items: ReturnType<typeof serializeTask>[];
  meta: PageMeta;
  summary: { todo: number; inProgress: number; overdue: number; doneThisWeek: number };
}> {
  const scope = viewWhere(auth, query.view);
  const where: Prisma.TaskWhereInput = {
    AND: [
      scope,
      statusWhere(query.status),
      query.assigneeId ? { assigneeId: query.assigneeId } : {},
      query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { assignee: { firstName: { contains: query.q, mode: 'insensitive' } } },
              { assignee: { lastName: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  };
  const open = OPEN_STATUSES.includes(query.status as TaskStatus) || query.status === 'open';
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = open
    ? [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }, { createdAt: 'desc' }]
    : [{ updatedAt: 'desc' }];

  const todayKey = await todayKeyFor(auth);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { skip, take } = toSkipTake(query);

  const [rows, total, todo, inProgress, overdue, doneThisWeek] = await Promise.all([
    prisma.task.findMany({ where, include: taskInclude, orderBy, skip, take }),
    prisma.task.count({ where }),
    prisma.task.count({ where: { AND: [scope, { status: 'TODO' }] } }),
    prisma.task.count({ where: { AND: [scope, { status: 'IN_PROGRESS' }] } }),
    prisma.task.count({
      where: { AND: [scope, { status: { in: OPEN_STATUSES } }, { dueDate: { lt: toUtcDate(todayKey) } }] },
    }),
    prisma.task.count({ where: { AND: [scope, { status: 'DONE' }, { completedAt: { gte: weekAgo } }] } }),
  ]);

  return {
    items: rows.map((row) => serializeTask(row, auth, todayKey)),
    meta: buildPageMeta(query.page, query.pageSize, total),
    summary: { todo, inProgress, overdue, doneThisWeek },
  };
}

/**
 * The people the caller may give a task to, for the picker: themselves, their
 * direct reports, and for HR everyone in scope who has not left.
 */
export async function listAssignees(auth: AuthContext, q?: string) {
  const reach: Prisma.EmployeeWhereInput[] = [];
  if (auth.employeeId) reach.push({ id: auth.employeeId }, { managerId: auth.employeeId });
  if (isManagement(auth)) reach.push(entityScopeWhere(auth));
  if (reach.length === 0) return [];

  const people = await prisma.employee.findMany({
    where: {
      AND: [
        { OR: reach },
        { status: { not: 'OFFBOARDED' } },
        q
          ? {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { employeeNumber: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    },
    select: personSelect,
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    take: 100,
  });

  return people.map((person) => ({
    id: person.id,
    fullName: fullName(person),
    employeeNumber: person.employeeNumber,
    jobTitle: person.jobTitle,
    isSelf: person.id === auth.employeeId,
  }));
}

async function loadAssignee(auth: AuthContext, assigneeId: string) {
  const assignee = await prisma.employee.findUnique({
    where: { id: assigneeId },
    select: { ...personSelect, status: true },
  });
  if (!assignee) {
    throw new NotFoundError('Employee');
  }
  assertCanAssignTaskTo(auth, assignee);
  if (assignee.status === 'OFFBOARDED') {
    throw new ValidationError('Validation failed', { assigneeId: [`${fullName(assignee)} has left the company`] });
  }
  return assignee;
}

export async function createTask(auth: AuthContext, input: TaskCreateInput, fingerprint: Fingerprint) {
  const assigneeId = input.assigneeId ?? auth.employeeId;
  if (!assigneeId) {
    throw new ValidationError('Validation failed', { assigneeId: ['Choose who the task is for'] });
  }
  const assignee = await loadAssignee(auth, assigneeId);

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueDate: input.dueDate ? toUtcDate(input.dueDate) : null,
        assigneeId: assignee.id,
        legalEntityId: assignee.legalEntityId,
        createdById: auth.userId,
      },
      include: taskInclude,
    });
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'Task',
        entityId: created.id,
        legalEntityId: assignee.legalEntityId,
        summary: `Created task "${created.title}" for ${fullName(assignee)}`,
        after: { title: created.title, priority: created.priority, dueDate: input.dueDate ?? null },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return created;
  });

  if (!isSelf(auth, assignee)) {
    await notifyEmployee(assignee.id, {
      type: 'TASK_ASSIGNED',
      title: `New task: ${task.title}`,
      body: `${await callerName(auth)} gave you a task${input.dueDate ? `, due ${input.dueDate}` : ''}.`,
      entityType: 'Task',
      entityId: task.id,
    });
  }

  return serializeTask(task, auth, await todayKeyFor(auth));
}

export async function getTask(auth: AuthContext, id: string) {
  const task = await loadVisibleTask(auth, id);
  const comments = await prisma.taskComment.findMany({
    where: { taskId: id },
    include: { author: { select: userNameSelect } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    ...serializeTask(task, auth, await todayKeyFor(auth)),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      author: comment.author ? { id: comment.author.id, fullName: userName(comment.author) } : null,
      isMine: comment.authorId === auth.userId,
    })),
  };
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'to do',
  IN_PROGRESS: 'in progress',
  DONE: 'done',
  CANCELLED: 'cancelled',
};

export async function updateTask(auth: AuthContext, id: string, input: TaskUpdateInput, fingerprint: Fingerprint) {
  const task = await loadVisibleTask(auth, id);
  const subject = accessSubject(task);

  const rewrites =
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    (input.assigneeId !== undefined && input.assigneeId !== task.assigneeId);
  // Cancelling, or bringing a cancelled task back, is the creator's call too.
  const cancels = input.status !== undefined && (input.status === 'CANCELLED' || task.status === 'CANCELLED');
  if ((rewrites || cancels) && !canEditTask(auth, subject)) {
    throw new ForbiddenError('Only the person who created this task, or HR, can change it');
  }
  if (input.status !== undefined && !canProgressTask(auth, subject)) {
    throw new ForbiddenError('You cannot update this task');
  }

  const newAssignee =
    input.assigneeId !== undefined && input.assigneeId !== task.assigneeId
      ? await loadAssignee(auth, input.assigneeId)
      : null;

  const statusChanged = input.status !== undefined && input.status !== task.status;
  const data: Prisma.TaskUncheckedUpdateInput = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? toUtcDate(input.dueDate) : null } : {}),
    ...(newAssignee ? { assigneeId: newAssignee.id, legalEntityId: newAssignee.legalEntityId } : {}),
    ...(statusChanged
      ? { status: input.status, completedAt: input.status === 'DONE' ? new Date() : null }
      : {}),
  };

  const before = {
    title: task.title,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate ? toDateKey(task.dueDate) : null,
    assignee: fullName(task.assignee),
  };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.task.update({ where: { id }, data, include: taskInclude });
    const after = {
      title: row.title,
      priority: row.priority,
      status: row.status,
      dueDate: row.dueDate ? toDateKey(row.dueDate) : null,
      assignee: fullName(row.assignee),
    };
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((key) => after[key] !== before[key]);
    await recordAudit(
      {
        action: input.status === 'CANCELLED' && statusChanged ? 'CANCEL' : 'UPDATE',
        entityType: 'Task',
        entityId: row.id,
        legalEntityId: row.legalEntityId,
        summary:
          statusChanged && changes.length === 1
            ? `Moved task "${row.title}" to ${STATUS_LABEL[row.status]}`
            : `Updated task "${row.title}"${changes.length ? ` (${changes.join(', ')})` : ''}`,
        before,
        after,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return row;
  });

  const actor = await callerName(auth);
  if (newAssignee && !isSelf(auth, newAssignee)) {
    await notifyEmployee(newAssignee.id, {
      type: 'TASK_ASSIGNED',
      title: `New task: ${updated.title}`,
      body: `${actor} gave you a task${updated.dueDate ? `, due ${toDateKey(updated.dueDate)}` : ''}.`,
      entityType: 'Task',
      entityId: updated.id,
    });
  } else if ((rewrites || statusChanged) && !isSelf(auth, updated.assignee)) {
    await notifyEmployee(updated.assignee.id, {
      type: 'TASK_UPDATED',
      title: `Task updated: ${updated.title}`,
      body: statusChanged
        ? `${actor} moved it to ${STATUS_LABEL[updated.status]}.`
        : `${actor} changed the details.`,
      entityType: 'Task',
      entityId: updated.id,
    });
  }
  // The person who asked for the work hears when it moves.
  if (statusChanged && updated.createdById && updated.createdById !== auth.userId) {
    await notifyUser(updated.createdById, {
      type: 'TASK_UPDATED',
      title: updated.status === 'DONE' ? `Task done: ${updated.title}` : `Task ${STATUS_LABEL[updated.status]}: ${updated.title}`,
      body: `${actor} moved it to ${STATUS_LABEL[updated.status]}.`,
      entityType: 'Task',
      entityId: updated.id,
    });
  }

  return serializeTask(updated, auth, await todayKeyFor(auth));
}

export async function deleteTask(auth: AuthContext, id: string, fingerprint: Fingerprint): Promise<{ id: string }> {
  const task = await loadVisibleTask(auth, id);
  if (!canEditTask(auth, accessSubject(task))) {
    throw new ForbiddenError('Only the person who created this task, or HR, can delete it');
  }
  await prisma.$transaction(async (tx) => {
    await tx.task.delete({ where: { id } });
    await recordAudit(
      {
        action: 'DELETE',
        entityType: 'Task',
        entityId: id,
        legalEntityId: task.legalEntityId,
        summary: `Deleted task "${task.title}" (was for ${fullName(task.assignee)})`,
        before: { title: task.title, status: task.status, assignee: fullName(task.assignee) },
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
  });
  return { id };
}

export async function addTaskComment(auth: AuthContext, id: string, body: string) {
  const task = await loadVisibleTask(auth, id);
  const comment = await prisma.taskComment.create({
    data: { taskId: id, authorId: auth.userId, body },
    include: { author: { select: userNameSelect } },
  });

  // Everyone with a stake in the task, except whoever wrote the comment.
  const author = comment.author ? userName(comment.author) : auth.email;
  const preview = body.length > 140 ? `${body.slice(0, 137)}...` : body;
  const notice = {
    type: 'TASK_COMMENTED' as const,
    title: `Comment on: ${task.title}`,
    body: `${author}: ${preview}`,
    entityType: 'Task',
    entityId: task.id,
  };
  if (!isSelf(auth, task.assignee)) {
    await notifyEmployee(task.assignee.id, notice);
  }
  const assigneeUser = await prisma.user.findUnique({ where: { employeeId: task.assignee.id }, select: { id: true } });
  if (task.createdById && task.createdById !== auth.userId && task.createdById !== assigneeUser?.id) {
    await notifyUser(task.createdById, notice);
  }

  return {
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
    author: comment.author ? { id: comment.author.id, fullName: userName(comment.author) } : null,
    isMine: true,
  };
}

