import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  assignScheduleSchema,
  assignWorkSchedule,
  createWorkSchedule,
  getWorkSchedule,
  listWorkSchedules,
  updateWorkSchedule,
  updateWorkScheduleSchema,
  workScheduleSchema,
} from './work-schedules.service';

const listQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const workSchedulesRouter: Router = Router();

workSchedulesRouter.use(authenticate);

workSchedulesRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, listQuerySchema);
    sendData(res, await listWorkSchedules(requireAuth(req), query));
  }),
);

workSchedulesRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getWorkSchedule(requireAuth(req), id));
  }),
);

workSchedulesRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, workScheduleSchema);
    sendCreated(res, await createWorkSchedule(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

workSchedulesRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, updateWorkScheduleSchema);
    sendData(res, await updateWorkSchedule(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

workSchedulesRouter.post(
  '/:id/assign',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { employeeIds } = parseBody(req, assignScheduleSchema);
    sendData(res, await assignWorkSchedule(requireAuth(req), id, employeeIds, auditContextFromRequest(req)));
  }),
);
