import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createFixture, login, resetDatabase, type Fixture } from './fixture';
import { prisma } from '../src/db/prisma';
import { setAssistantModel, type AssistantModel, type ModelRequest } from '../src/modules/assistant/assistant.model';
import { ASSISTANT_TOOLS } from '../src/modules/assistant/assistant.tools';

/**
 * The HR assistant, with a scripted model in place of Gemini: the script
 * decides which tools to call, and the tests check what those tools hand
 * back - which is exactly what the real model would be shown.
 */

type Call = { name: string; args?: Record<string, unknown> };

/** A model that makes the given calls on its first turn, then answers. */
function scripted(calls: Call[], seen: ModelRequest[] = []): AssistantModel {
  return async (request) => {
    seen.push(structuredClone(request));
    const answered = request.contents.some((content) => content.parts?.some((part) => part.functionResponse));
    if (!answered && calls.length) {
      return {
        content: { role: 'model', parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.args ?? {} } })) },
        functionCalls: calls.map((call) => ({ name: call.name, args: call.args ?? {} })),
        text: '',
      };
    }
    return { content: { role: 'model', parts: [{ text: 'Done.' }] }, functionCalls: [], text: 'Here is the summary.' };
  };
}

/** What each tool returned, by tool name, from the last request the model saw. */
function toolResults(seen: ModelRequest[]): Record<string, any> {
  const last = seen.at(-1)!;
  const results: Record<string, any> = {};
  for (const content of last.contents) {
    for (const part of content.parts ?? []) {
      if (part.functionResponse?.name) results[part.functionResponse.name] = (part.functionResponse.response as { result: unknown }).result;
    }
  }
  return results;
}

const ask = (token: string, text: string) =>
  asUser(token).post('/api/v1/assistant/ask').send({ messages: [{ role: 'user', text }] });

describe('HR assistant', () => {
  let fixture: Fixture;
  let adminToken: string;
  let hrKsaToken: string;
  let managerToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    await resetDatabase();
    fixture = await createFixture();
    adminToken = await login(fixture.emails.admin);
    hrKsaToken = await login(fixture.emails.hrKsa);
    managerToken = await login(fixture.emails.manager);
    employeeToken = await login(fixture.emails.employee);
  });

  afterEach(() => setAssistantModel(null));

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is for managers, HR and administrators only', async () => {
    setAssistantModel(scripted([]));
    expect((await ask(employeeToken, 'Who is late today?')).status).toBe(403);
    expect((await asUser(employeeToken).get('/api/v1/assistant/status')).status).toBe(403);
    expect((await asUser(managerToken).get('/api/v1/assistant/status')).body.data).toEqual({ enabled: true, scope: 'team' });
    expect((await asUser(adminToken).get('/api/v1/assistant/status')).body.data).toEqual({ enabled: true, scope: 'company' });
  });

  it('says it is not set up when there is no Google key', async () => {
    expect((await asUser(adminToken).get('/api/v1/assistant/status')).body.data.enabled).toBe(false);
    const response = await ask(adminToken, 'Who is on leave today?');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ASSISTANT_UNAVAILABLE');
    expect(response.body.error.message).toContain('GOOGLE_API_KEY');
  });

  it('answers, names its sources, and keeps the question in the audit trail', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'attendance_today' }, { name: 'pending_approvals' }], seen));

    const response = await ask(adminToken, 'ملخص الحضور النهارده');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ answer: 'Here is the summary.', sources: ['Attendance today', 'Requests waiting for a decision'] });

    // The model is told who is asking, the date, and to answer in their language.
    expect(seen[0]!.systemInstruction).toContain('Ada Admin');
    expect(seen[0]!.systemInstruction).toMatch(/Today is \w+day \d{4}-\d{2}-\d{2} in Asia\/Dubai/);
    expect(seen[0]!.systemInstruction).toContain('Reply in the language of the user');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'AI_QUERY' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.summary).toBe('Asked the assistant: ملخص الحضور النهارده');
  });

  it('runs every tool it offers HR without error', async () => {
    const seen: ModelRequest[] = [];
    const calls: Call[] = [
      { name: 'attendance_today' },
      { name: 'attendance_summary', args: { from: '2026-11-02', to: '2026-11-06' } },
      { name: 'late_arrivals', args: { from: '2026-11-02', to: '2026-11-06' } },
      { name: 'absences', args: { from: '2026-11-02', to: '2026-11-06' } },
      { name: 'leave', args: { from: '2026-11-01', to: '2026-11-30', status: 'APPROVED' } },
      { name: 'leave_balances', args: { year: 2026 } },
      { name: 'overtime', args: { from: '2026-11-01', to: '2026-11-30' } },
      { name: 'employee_list' },
      { name: 'my_team' },
      { name: 'pending_approvals' },
      { name: 'tasks', args: { view: 'all' } },
    ];
    expect(calls.map((call) => call.name).sort()).toEqual(ASSISTANT_TOOLS.map((tool) => tool.name).sort());
    setAssistantModel(scripted(calls, seen));

    expect((await ask(adminToken, 'Everything, please')).status).toBe(200);
    const results = toolResults(seen);
    for (const call of calls) {
      expect(results[call.name], call.name).toBeDefined();
      expect(results[call.name].error, `${call.name}: ${results[call.name].error}`).toBeUndefined();
    }
    expect(results.leave_balances.columns).toContain('Available');
    expect(results.employee_list.rows.length).toBeGreaterThan(0);
  });

  it('gives a manager only their team - in the tools offered and in what they return', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'leave_balances', args: { year: 2026 } }, { name: 'employee_list' }], seen));

    expect((await ask(managerToken, 'Leave balances for my team')).status).toBe(200);
    const offered = seen[0]!.tools.map((tool) => tool.name);
    expect(offered).not.toContain('employee_list');
    expect(seen[0]!.systemInstruction).toContain('Eve Employee');

    const results = toolResults(seen);
    // Asked for anyway, a tool the manager was not offered is refused.
    expect(results.employee_list.error).toContain('There is no tool');
    const names = JSON.stringify(results.leave_balances.rows);
    expect(names).toContain('Eve Employee');
    expect(names).not.toContain('Cal Colleague');
    expect(names).not.toContain('Sami Saudi');
  });

  it('will not look up someone outside the manager’s team by name', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'late_arrivals', args: { from: '2026-11-02', to: '2026-11-06', person: 'Cal' } }], seen));

    await ask(managerToken, 'Was Cal late last week?');
    expect(toolResults(seen).late_arrivals).toEqual({ error: 'Nobody called "Cal" is among the people you can see.' });
  });

  it('keeps an entity-scoped HR admin inside their entity', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'employee_list' }], seen));

    await ask(hrKsaToken, 'Who works here?');
    const rows = JSON.stringify(toolResults(seen).employee_list.rows);
    expect(rows).toContain('Sami Saudi');
    expect(rows).not.toContain('Eve Employee');
  });

  it('asks which person when a name matches several', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'leave_balances', args: { person: 'e' } }], seen));

    await ask(adminToken, 'Balance for e?');
    const result = toolResults(seen).leave_balances;
    expect(result.error).toContain('matches several people');
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('passes a refused or invalid look-up back to the model to explain', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(scripted([{ name: 'attendance_summary', args: { from: '2026-01-01', to: '2026-12-31' } }], seen));

    expect((await ask(adminToken, 'Attendance for the whole year')).status).toBe(200);
    expect(toolResults(seen).attendance_summary.error).toContain('at most');
  });

  it('stops after a few rounds and makes the model answer without tools', async () => {
    const seen: ModelRequest[] = [];
    setAssistantModel(async (request) => {
      seen.push(request);
      return {
        content: { role: 'model', parts: [{ functionCall: { name: 'my_team', args: {} } }] },
        functionCalls: request.tools.length ? [{ name: 'my_team', args: {} }] : [],
        text: request.tools.length ? '' : 'Final answer.',
      };
    });

    const response = await ask(managerToken, 'Loop forever');
    expect(response.body.data.answer).toBe('Final answer.');
    expect(seen.at(-1)!.tools).toEqual([]);
    expect(seen.length).toBe(7);
  });

  it('turns a model failure into a friendly 503', async () => {
    setAssistantModel(async () => {
      throw new Error('upstream exploded');
    });
    const response = await ask(adminToken, 'Hello');
    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe('The assistant could not answer just now. Please try again in a moment.');
  });

  it('validates the conversation', async () => {
    setAssistantModel(scripted([]));
    const empty = await asUser(adminToken).post('/api/v1/assistant/ask').send({ messages: [] });
    expect(empty.status).toBe(422);
    const endsWithAnswer = await asUser(adminToken)
      .post('/api/v1/assistant/ask')
      .send({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] });
    expect(endsWithAnswer.status).toBe(422);
  });
});
