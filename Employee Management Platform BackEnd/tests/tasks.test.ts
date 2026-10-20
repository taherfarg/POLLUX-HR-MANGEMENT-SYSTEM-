import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';

/**
 * Tasks: who may give work to whom, who sees it, who moves it along and who
 * may rewrite it - and that the right people hear about each step.
 */
describe('tasks', () => {
  let fixture: Fixture;
  let adminToken: string;
  let hrKsaToken: string;
  let managerToken: string;
  let employeeToken: string;
  let colleagueToken: string;

  const userIdOf = async (employeeId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { employeeId }, select: { id: true } })).id;

  const notificationsFor = async (employeeId: string, type: string) =>
    prisma.notification.findMany({
      where: { userId: await userIdOf(employeeId), type: type as never },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    hrKsaToken = await login(fixture.emails.hrKsa);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
    colleagueToken = await login(fixture.emails.colleague);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('giving tasks', () => {
    it('lets anyone keep a personal to-do, with nobody notified', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/tasks')
        .send({ title: 'Renew parking permit', dueDate: '2026-12-01' });

      expect(response.status).toBe(201);
      expect(response.body.data.assignee.id).toBe(fixture.employee);
      expect(response.body.data.status).toBe('TODO');
      expect(response.body.data.priority).toBe('NORMAL');
      expect(response.body.data.dueDate).toBe('2026-12-01');
      expect(response.body.data.permissions).toEqual({ canEdit: true, canProgress: true, isAssignee: true });
      expect(await notificationsFor(fixture.employee, 'TASK_ASSIGNED')).toHaveLength(0);
    });

    it('lets a manager give a task to a direct report, who is notified', async () => {
      const response = await asUser(managerToken).post('/api/v1/tasks').send({
        title: 'Prepare the Q4 showroom report',
        description: 'Footfall and test drives per week.',
        priority: 'HIGH',
        dueDate: '2026-11-20',
        assigneeId: fixture.employee,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.createdBy.fullName).toBe('Mo Manager');
      // The assignee moves it along; only the creator or HR rewrites it.
      expect(response.body.data.permissions.canEdit).toBe(true);

      const [notice] = await notificationsFor(fixture.employee, 'TASK_ASSIGNED');
      expect(notice?.title).toBe('New task: Prepare the Q4 showroom report');
      expect(notice?.body).toContain('Mo Manager gave you a task, due 2026-11-20');
      expect(notice?.entityType).toBe('Task');

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Task', entityId: response.body.data.id } });
      expect(audit?.action).toBe('CREATE');
      expect(audit?.legalEntityId).toBe(fixture.entityAe);
    });

    it('refuses work handed to someone the caller does not manage', async () => {
      const fromColleague = await asUser(colleagueToken)
        .post('/api/v1/tasks')
        .send({ title: 'Do my filing', assigneeId: fixture.employee });
      expect(fromColleague.status).toBe(403);

      const upwards = await asUser(employeeToken)
        .post('/api/v1/tasks')
        .send({ title: 'Approve my leave', assigneeId: fixture.manager });
      expect(upwards.status).toBe(403);

      // HR scoped to KSA cannot reach a UAE employee.
      const outOfScope = await asUser(hrKsaToken)
        .post('/api/v1/tasks')
        .send({ title: 'Upload passport copy', assigneeId: fixture.employee });
      expect(outOfScope.status).toBe(403);
    });

    it('lets HR give a task to anyone in scope', async () => {
      const response = await asUser(adminToken)
        .post('/api/v1/tasks')
        .send({ title: 'Upload your Emirates ID', assigneeId: fixture.colleague, priority: 'URGENT' });
      expect(response.status).toBe(201);

      const inScope = await asUser(hrKsaToken)
        .post('/api/v1/tasks')
        .send({ title: 'Complete onboarding form', assigneeId: fixture.ksaEmployee });
      expect(inScope.status).toBe(201);
    });

    it('validates the title and the due date', async () => {
      const response = await asUser(employeeToken)
        .post('/api/v1/tasks')
        .send({ title: 'x', dueDate: '2026-02-30' });
      expect(response.status).toBe(422);
    });

    it('offers each person only the people they may give tasks to', async () => {
      const own = await asUser(employeeToken).get('/api/v1/tasks/assignees');
      expect(own.body.data.map((person: { id: string }) => person.id)).toEqual([fixture.employee]);

      const team = await asUser(managerToken).get('/api/v1/tasks/assignees');
      expect(team.body.data.map((person: { id: string }) => person.id).sort()).toEqual(
        [fixture.manager, fixture.employee].sort(),
      );

      const ksa = await asUser(hrKsaToken).get('/api/v1/tasks/assignees');
      const ksaIds = ksa.body.data.map((person: { id: string }) => person.id);
      expect(ksaIds).toContain(fixture.ksaEmployee);
      expect(ksaIds).not.toContain(fixture.employee);
    });
  });

  describe('seeing tasks', () => {
    it('hides a task from a colleague with no stake in it', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const colleague = await asUser(colleagueToken).get(`/api/v1/tasks/${task.id}`);
      expect(colleague.status).toBe(404);

      const hrKsa = await asUser(hrKsaToken).get(`/api/v1/tasks/${task.id}`);
      expect(hrKsa.status).toBe(404);

      const admin = await asUser(adminToken).get(`/api/v1/tasks/${task.id}`);
      expect(admin.status).toBe(200);
    });

    it('lists the right tasks in each view', async () => {
      const mine = await asUser(employeeToken).get('/api/v1/tasks?view=mine');
      expect(mine.body.data.map((task: { title: string }) => task.title).sort()).toEqual([
        'Prepare the Q4 showroom report',
        'Renew parking permit',
      ]);
      // Open tasks come soonest-due first.
      expect(mine.body.data[0].title).toBe('Prepare the Q4 showroom report');

      const team = await asUser(managerToken).get('/api/v1/tasks?view=team');
      expect(team.body.data).toHaveLength(2);

      const created = await asUser(managerToken).get('/api/v1/tasks?view=created');
      expect(created.body.data).toHaveLength(1);

      const all = await asUser(hrKsaToken).get('/api/v1/tasks?view=all');
      expect(all.body.data.map((task: { title: string }) => task.title)).toEqual(['Complete onboarding form']);

      const notHr = await asUser(employeeToken).get('/api/v1/tasks?view=all');
      expect(notHr.status).toBe(403);
    });

    it('counts overdue work in the summary', async () => {
      const overdue = await asUser(employeeToken)
        .post('/api/v1/tasks')
        .send({ title: 'Submit mileage claim', dueDate: '2020-01-31' });
      expect(overdue.body.data.isOverdue).toBe(true);

      const list = await asUser(employeeToken).get('/api/v1/tasks?view=mine');
      expect(list.body.summary).toMatchObject({ todo: 3, inProgress: 0, overdue: 1, doneThisWeek: 0 });

      const search = await asUser(employeeToken).get('/api/v1/tasks?view=mine&q=mileage');
      expect(search.body.data).toHaveLength(1);
    });
  });

  describe('working on a task', () => {
    it('lets the assignee move it along, and tells the person who asked when it is done', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const started = await asUser(employeeToken).patch(`/api/v1/tasks/${task.id}`).send({ status: 'IN_PROGRESS' });
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('IN_PROGRESS');

      const done = await asUser(employeeToken).patch(`/api/v1/tasks/${task.id}`).send({ status: 'DONE' });
      expect(done.body.data.status).toBe('DONE');
      expect(done.body.data.completedAt).not.toBeNull();

      const notices = await notificationsFor(fixture.manager, 'TASK_UPDATED');
      expect(notices.map((notice) => notice.title)).toContain('Task done: Prepare the Q4 showroom report');

      const reopened = await asUser(employeeToken).patch(`/api/v1/tasks/${task.id}`).send({ status: 'TODO' });
      expect(reopened.body.data.completedAt).toBeNull();
    });

    it('stops the assignee rewriting, cancelling or deleting what was asked', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const rewrite = await asUser(employeeToken).patch(`/api/v1/tasks/${task.id}`).send({ dueDate: '2027-06-01' });
      expect(rewrite.status).toBe(403);

      const cancel = await asUser(employeeToken).patch(`/api/v1/tasks/${task.id}`).send({ status: 'CANCELLED' });
      expect(cancel.status).toBe(403);

      const remove = await asUser(employeeToken).delete(`/api/v1/tasks/${task.id}`);
      expect(remove.status).toBe(403);
    });

    it('lets the creator change the details, and the assignee hears about it', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const response = await asUser(managerToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ dueDate: '2026-11-27', priority: 'URGENT' });
      expect(response.status).toBe(200);
      expect(response.body.data.dueDate).toBe('2026-11-27');

      const notices = await notificationsFor(fixture.employee, 'TASK_UPDATED');
      expect(notices.at(-1)?.title).toBe('Task updated: Prepare the Q4 showroom report');

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'Task', entityId: task.id, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.summary).toContain('priority');
      expect(audit?.summary).toContain('dueDate');
    });

    it('refuses to reassign to someone the creator does not manage', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });
      const response = await asUser(managerToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ assigneeId: fixture.colleague });
      expect(response.status).toBe(403);
    });

    it('keeps a comment thread that notifies the other side', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const comment = await asUser(employeeToken)
        .post(`/api/v1/tasks/${task.id}/comments`)
        .send({ body: 'Do you want the Abu Dhabi branch included?' });
      expect(comment.status).toBe(201);
      expect(comment.body.data.isMine).toBe(true);

      const notices = await notificationsFor(fixture.manager, 'TASK_COMMENTED');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.body).toBe('Eve Employee: Do you want the Abu Dhabi branch included?');

      const outsider = await asUser(colleagueToken)
        .post(`/api/v1/tasks/${task.id}/comments`)
        .send({ body: 'Hello' });
      expect(outsider.status).toBe(404);

      const detail = await asUser(managerToken).get(`/api/v1/tasks/${task.id}`);
      expect(detail.body.data.commentCount).toBe(1);
      expect(detail.body.data.comments[0]).toMatchObject({ isMine: false, author: { fullName: 'Eve Employee' } });
    });

    it('lets the creator delete a task, on the record', async () => {
      const task = await prisma.task.findFirstOrThrow({ where: { title: 'Prepare the Q4 showroom report' } });

      const response = await asUser(managerToken).delete(`/api/v1/tasks/${task.id}`);
      expect(response.status).toBe(200);
      expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
      expect(await prisma.taskComment.count({ where: { taskId: task.id } })).toBe(0);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Task', entityId: task.id, action: 'DELETE' } });
      expect(audit?.summary).toContain('was for Eve Employee');
    });
  });
});
