import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  addMembers,
  contactQuerySchema,
  conversationCreateSchema,
  conversationParamsSchema,
  conversationUpdateSchema,
  createConversation,
  deleteMessage,
  getConversation,
  leaveConversation,
  listContacts,
  listConversations,
  listMessages,
  markRead,
  membersAddSchema,
  messageCreateSchema,
  messageParamsSchema,
  messageQuerySchema,
  renameConversation,
  sendMessage,
  unreadSummary,
} from './chat.service';

export const chatRouter: Router = Router();

chatRouter.use(authenticate);

chatRouter.get(
  '/unread',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await unreadSummary(requireAuth(req)));
  }),
);

chatRouter.get(
  '/contacts',
  asyncHandler(async (req: Request, res: Response) => {
    const { q } = parseQuery(req, contactQuerySchema);
    sendData(res, await listContacts(requireAuth(req), q));
  }),
);

chatRouter.get(
  '/conversations',
  asyncHandler(async (req: Request, res: Response) => {
    const { items, totalUnread } = await listConversations(requireAuth(req));
    res.json({ data: items, totalUnread });
  }),
);

/** 201 for a new chat, 200 when a direct chat with that person already exists. */
chatRouter.post(
  '/conversations',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, conversationCreateSchema);
    const { conversation, created } = await createConversation(requireAuth(req), input, auditContextFromRequest(req));
    if (created) sendCreated(res, conversation);
    else sendData(res, conversation);
  }),
);

chatRouter.get(
  '/conversations/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    sendData(res, await getConversation(requireAuth(req), id));
  }),
);

chatRouter.patch(
  '/conversations/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    const { title } = parseBody(req, conversationUpdateSchema);
    sendData(res, await renameConversation(requireAuth(req), id, title));
  }),
);

chatRouter.post(
  '/conversations/:id/members',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    const { userIds } = parseBody(req, membersAddSchema);
    sendData(res, await addMembers(requireAuth(req), id, userIds));
  }),
);

chatRouter.post(
  '/conversations/:id/leave',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    sendData(res, await leaveConversation(requireAuth(req), id));
  }),
);

chatRouter.post(
  '/conversations/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    sendData(res, await markRead(requireAuth(req), id));
  }),
);

chatRouter.get(
  '/conversations/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    const query = parseQuery(req, messageQuerySchema);
    const { items, hasMore } = await listMessages(requireAuth(req), id, query);
    res.json({ data: items, hasMore });
  }),
);

chatRouter.post(
  '/conversations/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, conversationParamsSchema);
    const { body } = parseBody(req, messageCreateSchema);
    sendCreated(res, await sendMessage(requireAuth(req), id, body));
  }),
);

chatRouter.delete(
  '/conversations/:id/messages/:messageId',
  asyncHandler(async (req: Request, res: Response) => {
    const { id, messageId } = parseParams(req, messageParamsSchema);
    sendData(res, await deleteMessage(requireAuth(req), id, messageId));
  }),
);
