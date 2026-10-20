import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { optionalTrimmedString, requiredTrimmedString } from '../../common/validate';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import type { AuthContext } from '../../common/auth-context';
import { recordAudit, type AuditInput } from '../../services/audit.service';
import { fullName } from '../employees/employee.serializer';

type Fingerprint = Pick<AuditInput, 'ipAddress' | 'userAgent'>;

/**
 * Chat between logins: one-to-one and named groups.
 *
 * Privacy: a conversation is readable by its members only. HR and
 * administrators get no back door - there is no endpoint that lists or reads
 * other people's chats, and every query below is scoped by membership.
 *
 * Delivery is by polling. Every timestamp the polling compares - message
 * createdAt and updatedAt, a member's joinedAt and lastReadAt - is set by the
 * API process, never by the database clock, so a skew between the two can
 * never hide or repeat a message.
 */

const MESSAGE_PAGE = 50;
/** Changes are re-sent from a little before the client's cursor, so a message
 * whose transaction committed after a later one is still picked up. */
const POLL_OVERLAP_MS = 10_000;
const MAX_GROUP_MEMBERS = 100;

const userIdList = z.array(z.string().trim().min(1).max(40)).min(1).max(MAX_GROUP_MEMBERS - 1);

export const conversationCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('DIRECT'), userId: z.string().trim().min(1).max(40) }),
  z.object({ kind: z.literal('GROUP'), title: requiredTrimmedString(2, 80), userIds: userIdList }),
]);

export const conversationUpdateSchema = z.object({ title: requiredTrimmedString(2, 80) });
export const membersAddSchema = z.object({ userIds: userIdList });
export const messageCreateSchema = z.object({ body: requiredTrimmedString(1, 4000) });

const isoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const messageQuerySchema = z.object({
  /** Older history: the page of messages sent before this moment. */
  before: isoInstant.optional(),
  /** Polling: everything sent, or deleted, since this moment. */
  since: isoInstant.optional(),
});

export const contactQuerySchema = z.object({ q: optionalTrimmedString(100) });

export const conversationParamsSchema = z.object({ id: z.string().min(1) });
export const messageParamsSchema = z.object({ id: z.string().min(1), messageId: z.string().min(1) });

export type ConversationCreateInput = z.infer<typeof conversationCreateSchema>;
export type MessageQuery = z.infer<typeof messageQuerySchema>;

const personSelect = {
  id: true,
  email: true,
  isActive: true,
  employee: {
    select: {
      firstName: true,
      lastName: true,
      preferredName: true,
      jobTitle: true,
      department: { select: { name: true } },
    },
  },
} satisfies Prisma.UserSelect;

type Person = Prisma.UserGetPayload<{ select: typeof personSelect }>;

function personName(user: Person): string {
  return user.employee ? fullName(user.employee) : user.email;
}

function serializePerson(user: Person, auth: AuthContext) {
  return {
    id: user.id,
    fullName: personName(user),
    jobTitle: user.employee?.jobTitle ?? null,
    department: user.employee?.department?.name ?? null,
    isActive: user.isActive,
    isMe: user.id === auth.userId,
  };
}

const messageInclude = { sender: { select: personSelect } } satisfies Prisma.ChatMessageInclude;
type MessageRow = Prisma.ChatMessageGetPayload<{ include: typeof messageInclude }>;

function serializeMessage(message: MessageRow, auth: AuthContext) {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    body: deleted ? null : message.body,
    isSystem: message.isSystem,
    isDeleted: deleted,
    isMine: message.senderId === auth.userId,
    sender: message.sender ? { id: message.sender.id, fullName: personName(message.sender) } : null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

const conversationInclude = {
  members: { include: { user: { select: personSelect } }, orderBy: { joinedAt: 'asc' } },
  messages: { include: messageInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

function serializeConversation(conversation: ConversationRow, auth: AuthContext, unreadCount: number) {
  const members = conversation.members.map((member) => serializePerson(member.user, auth));
  const others = members.filter((member) => !member.isMe);
  const last = conversation.messages[0];
  return {
    id: conversation.id,
    kind: conversation.kind,
    // A direct chat is named after the other person, so each side sees the other.
    title:
      conversation.kind === 'DIRECT'
        ? others[0]?.fullName ?? 'Former colleague'
        : conversation.title ?? 'Group',
    subtitle:
      conversation.kind === 'DIRECT'
        ? others[0]?.jobTitle ?? null
        : `${members.length} members`,
    members,
    lastMessage: last ? serializeMessage(last, auth) : null,
    lastMessageAt: conversation.lastMessageAt,
    unreadCount,
    canRename: conversation.kind === 'GROUP',
  };
}

/**
 * Unread messages per conversation for one user: other people's messages sent
 * after the member last read, or since they joined if they never have.
 */
async function unreadCounts(userId: string, conversationIds?: string[]): Promise<Map<string, number>> {
  const filter =
    conversationIds && conversationIds.length > 0
      ? Prisma.sql`AND m."conversationId" IN (${Prisma.join(conversationIds)})`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
    SELECT m."conversationId", COUNT(*)::int AS unread
    FROM chat_messages m
    JOIN conversation_members cm
      ON cm."conversationId" = m."conversationId" AND cm."userId" = ${userId}
    WHERE m."senderId" IS DISTINCT FROM ${userId}
      AND m."deletedAt" IS NULL
      AND (CASE WHEN cm."lastReadAt" IS NULL
                THEN m."createdAt" >= cm."joinedAt"
                ELSE m."createdAt" > cm."lastReadAt" END)
      ${filter}
    GROUP BY m."conversationId"`;
  return new Map(rows.map((row) => [row.conversationId, row.unread]));
}

/** The caller's membership, or not found: a non-member cannot tell the chat exists. */
async function requireMembership(auth: AuthContext, conversationId: string, client: TxClient = prisma) {
  const member = await client.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: auth.userId } },
    include: { conversation: true },
  });
  if (!member) {
    throw new NotFoundError('Conversation');
  }
  return member;
}

async function loadConversation(auth: AuthContext, id: string) {
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id }, include: conversationInclude });
  const unread = await unreadCounts(auth.userId, [id]);
  return serializeConversation(conversation, auth, unread.get(id) ?? 0);
}

async function loadPeople(auth: AuthContext, userIds: string[]): Promise<Person[]> {
  const unique = [...new Set(userIds)].filter((id) => id !== auth.userId);
  const people = await prisma.user.findMany({ where: { id: { in: unique }, isActive: true }, select: personSelect });
  if (people.length !== unique.length) {
    throw new ValidationError('Validation failed', { userIds: ['Some of these people cannot be found or have left'] });
  }
  return people;
}

async function systemMessage(tx: TxClient, conversationId: string, body: string, at: Date): Promise<void> {
  await tx.chatMessage.create({
    data: { conversationId, body, isSystem: true, createdAt: at, updatedAt: at },
  });
  await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at } });
}

async function callerPerson(auth: AuthContext): Promise<Person> {
  return prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: personSelect });
}

// ---------------------------------------------------------------------------

/** Everyone the caller can start a chat with: active colleagues with a login. */
export async function listContacts(auth: AuthContext, q?: string) {
  const people = await prisma.user.findMany({
    where: {
      isActive: true,
      id: { not: auth.userId },
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { employee: { firstName: { contains: q, mode: 'insensitive' } } },
              { employee: { lastName: { contains: q, mode: 'insensitive' } } },
              { employee: { jobTitle: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    select: personSelect,
    take: 200,
  });
  return people
    .map((person) => serializePerson(person, auth))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function listConversations(auth: AuthContext) {
  const conversations = await prisma.conversation.findMany({
    where: { members: { some: { userId: auth.userId } } },
    include: conversationInclude,
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
  });
  const unread = await unreadCounts(auth.userId);
  const items = conversations.map((conversation) =>
    serializeConversation(conversation, auth, unread.get(conversation.id) ?? 0),
  );
  return { items, totalUnread: items.reduce((total, item) => total + item.unreadCount, 0) };
}

/** The badge: cheap enough to poll from every page. */
export async function unreadSummary(auth: AuthContext) {
  const unread = await unreadCounts(auth.userId);
  let messages = 0;
  for (const count of unread.values()) messages += count;
  return { messages, conversations: unread.size };
}

export async function getConversation(auth: AuthContext, id: string) {
  await requireMembership(auth, id);
  return loadConversation(auth, id);
}

/**
 * Opens a chat. A direct chat with someone the caller already talks to returns
 * the existing one, so there is only ever one thread between two people.
 */
export async function createConversation(auth: AuthContext, input: ConversationCreateInput, fingerprint: Fingerprint) {
  if (input.kind === 'DIRECT') {
    if (input.userId === auth.userId) {
      throw new ValidationError('Validation failed', { userId: ['Choose someone other than yourself'] });
    }
    await loadPeople(auth, [input.userId]);
    const directKey = [auth.userId, input.userId].sort().join(':');
    const existing = await prisma.conversation.findUnique({ where: { directKey }, select: { id: true } });
    if (existing) {
      return { conversation: await loadConversation(auth, existing.id), created: false };
    }
    const now = new Date();
    try {
      const created = await prisma.conversation.create({
        data: {
          kind: 'DIRECT',
          directKey,
          createdById: auth.userId,
          lastMessageAt: now,
          createdAt: now,
          members: {
            create: [
              { userId: auth.userId, joinedAt: now, lastReadAt: now },
              { userId: input.userId, joinedAt: now },
            ],
          },
        },
      });
      return { conversation: await loadConversation(auth, created.id), created: true };
    } catch (error) {
      // Both people opened the chat at the same moment: use the one that won.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await prisma.conversation.findUniqueOrThrow({ where: { directKey }, select: { id: true } });
        return { conversation: await loadConversation(auth, winner.id), created: false };
      }
      throw error;
    }
  }

  const people = await loadPeople(auth, input.userIds);
  if (people.length === 0) {
    throw new ValidationError('Validation failed', { userIds: ['Add at least one other person'] });
  }
  const me = await callerPerson(auth);
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        kind: 'GROUP',
        title: input.title,
        createdById: auth.userId,
        lastMessageAt: now,
        createdAt: now,
        members: {
          create: [
            { userId: auth.userId, joinedAt: now, lastReadAt: now },
            ...people.map((person) => ({ userId: person.id, joinedAt: now })),
          ],
        },
      },
    });
    await systemMessage(tx, conversation.id, `${personName(me)} created the group "${input.title}"`, now);
    await recordAudit(
      {
        action: 'CREATE',
        entityType: 'Conversation',
        entityId: conversation.id,
        summary: `Created chat group "${input.title}" with ${people.length + 1} members`,
        actor: auth,
        ...fingerprint,
      },
      tx,
    );
    return conversation;
  });
  return { conversation: await loadConversation(auth, created.id), created: true };
}

export async function renameConversation(auth: AuthContext, id: string, title: string) {
  const member = await requireMembership(auth, id);
  if (member.conversation.kind !== 'GROUP') {
    throw new ValidationError('A direct chat has no name to change');
  }
  if (member.conversation.title !== title) {
    const me = await callerPerson(auth);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { title } });
      await systemMessage(tx, id, `${personName(me)} renamed the group to "${title}"`, now);
    });
  }
  return loadConversation(auth, id);
}

export async function addMembers(auth: AuthContext, id: string, userIds: string[]) {
  const member = await requireMembership(auth, id);
  if (member.conversation.kind !== 'GROUP') {
    throw new ValidationError('People can only be added to a group');
  }
  const existing = await prisma.conversationMember.findMany({ where: { conversationId: id }, select: { userId: true } });
  const already = new Set(existing.map((row) => row.userId));
  const people = (await loadPeople(auth, userIds)).filter((person) => !already.has(person.id));
  if (people.length === 0) {
    throw new ConflictError('Everyone chosen is already in this group');
  }
  if (already.size + people.length > MAX_GROUP_MEMBERS) {
    throw new ValidationError(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
  }
  const me = await callerPerson(auth);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.createMany({
      data: people.map((person) => ({ conversationId: id, userId: person.id, joinedAt: now })),
    });
    const names = people.map(personName).join(', ');
    await systemMessage(tx, id, `${personName(me)} added ${names}`, now);
  });
  return loadConversation(auth, id);
}

/** Leaving a group. The last person out takes the group with them. */
export async function leaveConversation(auth: AuthContext, id: string): Promise<{ id: string; left: true }> {
  const member = await requireMembership(auth, id);
  if (member.conversation.kind !== 'GROUP') {
    throw new ValidationError('You cannot leave a direct chat');
  }
  const me = await callerPerson(auth);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.delete({ where: { conversationId_userId: { conversationId: id, userId: auth.userId } } });
    const remaining = await tx.conversationMember.count({ where: { conversationId: id } });
    if (remaining === 0) {
      await tx.conversation.delete({ where: { id } });
    } else {
      await systemMessage(tx, id, `${personName(me)} left the group`, now);
    }
  });
  return { id, left: true };
}

export async function listMessages(auth: AuthContext, id: string, query: MessageQuery) {
  await requireMembership(auth, id);

  if (query.since) {
    const from = new Date(query.since.getTime() - POLL_OVERLAP_MS);
    const changed = await prisma.chatMessage.findMany({
      where: { conversationId: id, updatedAt: { gt: from } },
      include: messageInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return { items: changed.map((message) => serializeMessage(message, auth)), hasMore: false };
  }

  const page = await prisma.chatMessage.findMany({
    where: { conversationId: id, ...(query.before ? { createdAt: { lt: query.before } } : {}) },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MESSAGE_PAGE + 1,
  });
  const hasMore = page.length > MESSAGE_PAGE;
  const items = page.slice(0, MESSAGE_PAGE).reverse();
  return { items: items.map((message) => serializeMessage(message, auth)), hasMore };
}

export async function sendMessage(auth: AuthContext, id: string, body: string) {
  await requireMembership(auth, id);
  const now = new Date();
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: { conversationId: id, senderId: auth.userId, body, createdAt: now, updatedAt: now },
      include: messageInclude,
    });
    await tx.conversation.update({ where: { id }, data: { lastMessageAt: now } });
    // Sending is reading: everything up to your own message has been seen.
    await tx.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId: auth.userId } },
      data: { lastReadAt: now },
    });
    return created;
  });
  return serializeMessage(message, auth);
}

/**
 * Marks the conversation read up to its newest message. Uses that message's
 * own timestamp rather than "now", so the mark and the messages share a clock.
 */
export async function markRead(auth: AuthContext, id: string): Promise<{ id: string; unreadCount: 0 }> {
  await requireMembership(auth, id);
  const newest = await prisma.chatMessage.findFirst({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  if (newest) {
    await prisma.conversationMember.updateMany({
      where: {
        conversationId: id,
        userId: auth.userId,
        OR: [{ lastReadAt: null }, { lastReadAt: { lt: newest.createdAt } }],
      },
      data: { lastReadAt: newest.createdAt },
    });
  }
  return { id, unreadCount: 0 };
}

/** Unsending: your own message only. The line stays, as "Message deleted". */
export async function deleteMessage(auth: AuthContext, conversationId: string, messageId: string) {
  await requireMembership(auth, conversationId);
  const message = await prisma.chatMessage.findFirst({ where: { id: messageId, conversationId } });
  if (!message || message.isSystem) {
    throw new NotFoundError('Message');
  }
  if (message.senderId !== auth.userId) {
    throw new ForbiddenError('You can only delete your own messages');
  }
  const updated = await prisma.chatMessage.update({
    where: { id: messageId },
    data: { deletedAt: message.deletedAt ?? new Date(), body: '', updatedAt: new Date() },
    include: messageInclude,
  });
  return serializeMessage(updated, auth);
}
