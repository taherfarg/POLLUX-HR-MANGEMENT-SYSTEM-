import { prisma } from '../../db/prisma';
import { AppError } from '../../common/errors';
import { assertCanAssignTaskTo, assertCanDecideRequest } from '../../services/access';
import { fullName } from '../employees/employee.serializer';
import { date, PERSON, resolvePerson, text, type AssistantTool } from './assistant.shared';

/**
 * Tools that prepare a change for the person to confirm. They check
 * everything the real endpoint will check - who may assign to whom, who may
 * decide which request - so the card never offers something that would be
 * refused, but they write nothing. The page shows the card; pressing its
 * button calls the ordinary endpoint (POST /tasks, /requests/:id/approve or
 * /reject) as the person, with its ordinary audit trail.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const PREPARED = 'Prepared and shown to the user as a card with a confirm button. Nothing has been done yet: tell them to check it and confirm.';

const refusal = (error: unknown) => {
  if (error instanceof AppError) return { error: error.message };
  throw error;
};

export const ACTION_TOOLS: AssistantTool[] = [
  {
    name: 'propose_task',
    label: 'Task prepared',
    description:
      'Prepare a task for the user to confirm: for themselves, a direct report, or (HR) anyone in scope. Use when they ask to assign, remind someone to do something, or follow up. Fill in a clear title; ask for anything essential you cannot infer.',
    forRole: 'ALL',
    parameters: {
      type: 'object',
      properties: {
        person: { ...PERSON, description: 'Who the task is for: part of their name. Use the user’s own name for a task for themselves.' },
        title: { type: 'string', description: 'Short task title, in the user’s language, 3-160 characters.' },
        details: { type: 'string', description: 'Optional context for the person doing it.' },
        dueDate: date('Optional due date'),
        priority: { type: 'string', enum: [...PRIORITIES] },
      },
      required: ['person', 'title'],
    },
    run: async (args, { auth, actions }) => {
      const title = text(args.title);
      if (!title || title.length < 3 || title.length > 160) return { error: 'The title must be 3-160 characters.' };
      const dueDate = text(args.dueDate);
      if (dueDate && !DATE_KEY.test(dueDate)) return { error: 'The due date must be YYYY-MM-DD.' };
      const priority = PRIORITIES.find((value) => value === args.priority) ?? 'NORMAL';

      const found = await resolvePerson(auth, text(args.person) ?? '');
      if ('error' in found) return found;
      const person = await prisma.employee.findUniqueOrThrow({
        where: { id: found.id },
        select: { id: true, legalEntityId: true, managerId: true, status: true, firstName: true, lastName: true, preferredName: true },
      });
      try {
        assertCanAssignTaskTo(auth, person);
      } catch (error) {
        return refusal(error);
      }
      if (person.status === 'OFFBOARDED') return { error: `${fullName(person)} has left the company.` };

      const details = text(args.details);
      const name = person.id === auth.employeeId ? 'you' : fullName(person);
      actions.push({
        type: 'create_task',
        title: person.id === auth.employeeId ? 'Task for yourself' : `Task for ${fullName(person)}`,
        details: [
          { label: 'Task', value: title },
          ...(details ? [{ label: 'Details', value: details }] : []),
          { label: 'Due', value: dueDate ?? 'No due date' },
          { label: 'Priority', value: priority.charAt(0) + priority.slice(1).toLowerCase() },
        ],
        payload: { assigneeId: person.id, title, description: details ?? null, dueDate: dueDate ?? null, priority },
      });
      return { prepared: true, for: name, title, dueDate: dueDate ?? null, priority, note: PREPARED };
    },
  },
  {
    name: 'propose_request_decision',
    label: 'Decision prepared',
    description:
      'Prepare approving or rejecting one pending request (leave, document or profile change) for the user to confirm. Find the reference first with pending_approvals. A rejection needs a reason the employee will read: if the user gave none, ask for it before calling this.',
    forRole: 'ALL',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'The request reference, e.g. LV-2026-0031.' },
        decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        note: { type: 'string', description: 'Note for the employee. Required to reject.' },
      },
      required: ['reference', 'decision'],
    },
    run: async (args, { auth, actions }) => {
      const reference = text(args.reference)?.toUpperCase();
      const decision = args.decision === 'REJECT' ? 'REJECT' : args.decision === 'APPROVE' ? 'APPROVE' : null;
      if (!reference || !decision) return { error: 'Give the request reference and APPROVE or REJECT.' };
      const note = text(args.note);
      if (decision === 'REJECT' && (!note || note.length < 3)) {
        return { error: 'A rejection needs a reason the employee will see. Ask the user for one.' };
      }

      const request = await prisma.request.findUnique({
        where: { reference },
        select: {
          id: true,
          reference: true,
          type: true,
          status: true,
          employeeId: true,
          legalEntityId: true,
          employee: { select: { firstName: true, lastName: true, preferredName: true, managerId: true } },
          leaveDetail: { select: { startDate: true, endDate: true, workingDays: true, leaveType: { select: { name: true } } } },
          documentDetail: { select: { documentType: true } },
        },
      });
      // A request the caller cannot decide reads the same as one that does not exist.
      if (!request) return { error: `There is no request ${reference}.` };
      try {
        assertCanDecideRequest(auth, request, request.employee.managerId);
      } catch (error) {
        return refusal(error);
      }
      if (request.status !== 'PENDING') return { error: `${reference} is already ${request.status.toLowerCase()}.` };

      const leave = request.leaveDetail;
      const what = leave
        ? `${leave.leaveType.name}, ${leave.startDate.toISOString().slice(0, 10)} to ${leave.endDate.toISOString().slice(0, 10)} (${Number(leave.workingDays)} working days)`
        : request.documentDetail
          ? `Document: ${request.documentDetail.documentType.replaceAll('_', ' ').toLowerCase()}`
          : 'Profile change';
      actions.push({
        type: 'decide_request',
        title: `${decision === 'APPROVE' ? 'Approve' : 'Reject'} ${request.reference}`,
        details: [
          { label: 'Employee', value: fullName(request.employee) },
          { label: 'Request', value: what },
          ...(note ? [{ label: decision === 'REJECT' ? 'Reason' : 'Note', value: note }] : []),
        ],
        payload: { requestId: request.id, reference: request.reference, decision, note: note ?? null },
      });
      return { prepared: true, reference, decision, employee: fullName(request.employee), note: PREPARED };
    },
  },
];
