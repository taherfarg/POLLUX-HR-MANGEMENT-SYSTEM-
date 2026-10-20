import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  addTaskComment,
  assigneeQuerySchema,
  createTask,
  deleteTask,
  getTask,
  listAssignees,
  listTasks,
  taskCommentSchema,
  taskCreateSchema,
  taskQuerySchema,
  taskUpdateSchema,
  updateTask,
} from './tasks.service';

export const tasksRouter: Router = Router();

tasksRouter.use(authenticate);

/** One view at a time: given to me, given by me, my team's, or all (HR). */
tasksRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, taskQuerySchema);
    const { items, meta, summary } = await listTasks(requireAuth(req), query);
    res.json({ data: items, meta, summary });
  }),
);

tasksRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, taskCreateSchema);
    sendCreated(res, await createTask(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

/** Who the caller may give a task to. Declared before `/:id`. */
tasksRouter.get(
  '/assignees',
  asyncHandler(async (req: Request, res: Response) => {
    const { q } = parseQuery(req, assigneeQuerySchema);
    sendData(res, await listAssignees(requireAuth(req), q));
  }),
);

tasksRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getTask(requireAuth(req), id));
  }),
);

tasksRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, taskUpdateSchema);
    sendData(res, await updateTask(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

tasksRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await deleteTask(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

tasksRouter.post(
  '/:id/comments',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { body } = parseBody(req, taskCommentSchema);
    sendCreated(res, await addTaskComment(requireAuth(req), id, body));
  }),
);
