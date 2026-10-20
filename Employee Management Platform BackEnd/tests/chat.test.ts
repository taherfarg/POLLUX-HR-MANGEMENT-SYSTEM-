import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import { apiRateLimitKey } from '../src/middleware/rate-limit';

/**
 * Chat: one thread per pair of people, named groups, unread counts, polling
 * for changes - and a conversation that nobody outside it can read, HR and
 * administrators included.
 */
describe('chat', () => {
  let fixture: Fixture;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let colleagueToken: string;
  const users: Record<'admin' | 'manager' | 'employee' | 'colleague' | 'ksaEmployee', string> = {
    admin: '',
    manager: '',
    employee: '',
    colleague: '',
    ksaEmployee: '',
  };
  let direct: string;
  let group: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
    colleagueToken = await login(fixture.emails.colleague);
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: fixture.emails[key] } });
      users[key] = user.id;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('lists colleagues to chat with, never yourself', async () => {
    const response = await asUser(employeeToken).get('/api/v1/chat/contacts');
    expect(response.status).toBe(200);
    const ids = response.body.data.map((person: { id: string }) => person.id);
    expect(ids).not.toContain(users.employee);
    expect(ids).toContain(users.manager);

    const search = await asUser(employeeToken).get('/api/v1/chat/contacts?q=design');
    expect(search.body.data.map((person: { fullName: string }) => person.fullName)).toEqual(['Cal Colleague']);
  });

  it('keeps one direct chat per pair, whoever opens it', async () => {
    const opened = await asUser(employeeToken)
      .post('/api/v1/chat/conversations')
      .send({ kind: 'DIRECT', userId: users.manager });
    expect(opened.status).toBe(201);
    expect(opened.body.data.title).toBe('Mo Manager');
    direct = opened.body.data.id;

    const again = await asUser(managerToken)
      .post('/api/v1/chat/conversations')
      .send({ kind: 'DIRECT', userId: users.employee });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(direct);
    // Each side sees the chat named after the other person.
    expect(again.body.data.title).toBe('Eve Employee');
  });

  it('refuses a chat with yourself or with an account that is switched off', async () => {
    const self = await asUser(employeeToken)
      .post('/api/v1/chat/conversations')
      .send({ kind: 'DIRECT', userId: users.employee });
    expect(self.status).toBe(422);

    await prisma.user.update({ where: { id: users.ksaEmployee }, data: { isActive: false } });
    const inactive = await asUser(employeeToken)
      .post('/api/v1/chat/conversations')
      .send({ kind: 'DIRECT', userId: users.ksaEmployee });
    expect(inactive.status).toBe(422);
    await prisma.user.update({ where: { id: users.ksaEmployee }, data: { isActive: true } });
  });

  it('delivers a message and counts it unread until it is read', async () => {
    const sent = await asUser(employeeToken)
      .post(`/api/v1/chat/conversations/${direct}/messages`)
      .send({ body: 'Morning! Is the showroom report still due Friday?' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.isMine).toBe(true);

    // The sender has nothing unread; the recipient has one.
    expect((await asUser(employeeToken).get('/api/v1/chat/unread')).body.data.messages).toBe(0);
    const badge = await asUser(managerToken).get('/api/v1/chat/unread');
    expect(badge.body.data).toEqual({ messages: 1, conversations: 1 });

    const list = await asUser(managerToken).get('/api/v1/chat/conversations');
    expect(list.body.totalUnread).toBe(1);
    expect(list.body.data[0]).toMatchObject({
      id: direct,
      unreadCount: 1,
      lastMessage: { body: 'Morning! Is the showroom report still due Friday?', isMine: false },
    });

    const thread = await asUser(managerToken).get(`/api/v1/chat/conversations/${direct}/messages`);
    expect(thread.body.data).toHaveLength(1);
    expect(thread.body.data[0].sender.fullName).toBe('Eve Employee');

    await asUser(managerToken).post(`/api/v1/chat/conversations/${direct}/read`);
    expect((await asUser(managerToken).get('/api/v1/chat/unread')).body.data.messages).toBe(0);
  });

  it('keeps a conversation private to its members, administrators included', async () => {
    for (const token of [colleagueToken, adminToken]) {
      expect((await asUser(token).get(`/api/v1/chat/conversations/${direct}`)).status).toBe(404);
      expect((await asUser(token).get(`/api/v1/chat/conversations/${direct}/messages`)).status).toBe(404);
      const post = await asUser(token).post(`/api/v1/chat/conversations/${direct}/messages`).send({ body: 'hi' });
      expect(post.status).toBe(404);
      const list = await asUser(token).get('/api/v1/chat/conversations');
      expect(list.body.data.map((conversation: { id: string }) => conversation.id)).not.toContain(direct);
    }
  });

  it('hands a polling client new messages and deletions since its last look', async () => {
    const before = await asUser(managerToken).get(`/api/v1/chat/conversations/${direct}/messages`);
    const cursor = before.body.data.at(-1).updatedAt as string;

    const reply = await asUser(managerToken)
      .post(`/api/v1/chat/conversations/${direct}/messages`)
      .send({ body: 'Yes - Friday, end of day.' });
    const oops = await asUser(managerToken)
      .post(`/api/v1/chat/conversations/${direct}/messages`)
      .send({ body: 'wrong chat, sorry' });

    // Only the sender can unsend.
    const notMine = await asUser(employeeToken).delete(`/api/v1/chat/conversations/${direct}/messages/${oops.body.data.id}`);
    expect(notMine.status).toBe(403);
    const unsent = await asUser(managerToken).delete(`/api/v1/chat/conversations/${direct}/messages/${oops.body.data.id}`);
    expect(unsent.status).toBe(200);
    expect(unsent.body.data).toMatchObject({ isDeleted: true, body: null });

    const changes = await asUser(employeeToken).get(
      `/api/v1/chat/conversations/${direct}/messages?since=${encodeURIComponent(cursor)}`,
    );
    const byId = new Map(changes.body.data.map((message: { id: string }) => [message.id, message]));
    expect(byId.get(reply.body.data.id)).toMatchObject({ body: 'Yes - Friday, end of day.' });
    expect(byId.get(oops.body.data.id)).toMatchObject({ isDeleted: true, body: null });
    expect(JSON.stringify(changes.body.data)).not.toContain('wrong chat');

    // A deleted message is not waiting to be read.
    expect((await asUser(employeeToken).get('/api/v1/chat/unread')).body.data.messages).toBe(1);
  });

  it('runs a named group: create, add people, rename and leave', async () => {
    const created = await asUser(managerToken)
      .post('/api/v1/chat/conversations')
      .send({ kind: 'GROUP', title: 'Showroom team', userIds: [users.employee] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ kind: 'GROUP', title: 'Showroom team', subtitle: '2 members' });
    group = created.body.data.id;

    // The new member sees the group, with its opening line unread.
    const memberView = await asUser(employeeToken).get('/api/v1/chat/conversations');
    const entry = memberView.body.data.find((conversation: { id: string }) => conversation.id === group);
    expect(entry.unreadCount).toBe(1);
    expect(entry.lastMessage).toMatchObject({ isSystem: true, body: 'Mo Manager created the group "Showroom team"' });

    const added = await asUser(employeeToken)
      .post(`/api/v1/chat/conversations/${group}/members`)
      .send({ userIds: [users.colleague] });
    expect(added.status).toBe(200);
    expect(added.body.data.members).toHaveLength(3);

    const again = await asUser(employeeToken)
      .post(`/api/v1/chat/conversations/${group}/members`)
      .send({ userIds: [users.colleague] });
    expect(again.status).toBe(409);

    const renamed = await asUser(colleagueToken).patch(`/api/v1/chat/conversations/${group}`).send({ title: 'Sales floor' });
    expect(renamed.body.data.title).toBe('Sales floor');

    const left = await asUser(colleagueToken).post(`/api/v1/chat/conversations/${group}/leave`);
    expect(left.status).toBe(200);
    expect((await asUser(colleagueToken).get(`/api/v1/chat/conversations/${group}/messages`)).status).toBe(404);

    const history = await asUser(managerToken).get(`/api/v1/chat/conversations/${group}/messages`);
    expect(history.body.data.map((message: { body: string }) => message.body)).toEqual([
      'Mo Manager created the group "Showroom team"',
      'Eve Employee added Cal Colleague',
      'Cal Colleague renamed the group to "Sales floor"',
      'Cal Colleague left the group',
    ]);

    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Conversation', entityId: group } });
    expect(audit?.action).toBe('CREATE');
  });

  it('does not rename or leave a direct chat', async () => {
    const rename = await asUser(employeeToken).patch(`/api/v1/chat/conversations/${direct}`).send({ title: 'Us' });
    expect(rename.status).toBe(422);
    const leave = await asUser(employeeToken).post(`/api/v1/chat/conversations/${direct}/leave`);
    expect(leave.status).toBe(422);
  });

  it('counts API calls per signed-in account, not per shared office address', () => {
    const asRequest = (authorization?: string) =>
      ({ headers: authorization ? { authorization } : {}, ip: '203.0.113.7' }) as unknown as Request;

    expect(apiRateLimitKey(asRequest(`Bearer ${employeeToken}`))).toBe(`user:${users.employee}`);
    expect(apiRateLimitKey(asRequest(`Bearer ${managerToken}`))).toBe(`user:${users.manager}`);
    expect(apiRateLimitKey(asRequest('Bearer forged.token.value'))).toBe('ip:203.0.113.7');
    expect(apiRateLimitKey(asRequest())).toBe('ip:203.0.113.7');
  });
});
