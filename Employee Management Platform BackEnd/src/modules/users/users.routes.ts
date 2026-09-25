import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  createUser,
  createUserSchema,
  listEmployeesWithoutLogin,
  listUsers,
  resetPasswordSchema,
  resetUserPassword,
  unlockUser,
  updateUser,
  updateUserSchema,
  userQuerySchema,
} from './users.service';

/** Users & Roles. HR and administrators; the finer rules live in the service. */
export const usersRouter: Router = Router();

usersRouter.use(authenticate, requireAdmin);

usersRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, userQuerySchema);
    const { items, meta, summary } = await listUsers(requireAuth(req), query);
    res.json({ data: items, meta, summary });
  }),
);

usersRouter.get(
  '/eligible-employees',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await listEmployeesWithoutLogin(requireAuth(req)));
  }),
);

usersRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, createUserSchema);
    sendCreated(res, await createUser(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

usersRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, updateUserSchema);
    sendData(res, await updateUser(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

usersRouter.post(
  '/:id/reset-password',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, resetPasswordSchema);
    sendData(res, await resetUserPassword(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

usersRouter.post(
  '/:id/unlock',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await unlockUser(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);
