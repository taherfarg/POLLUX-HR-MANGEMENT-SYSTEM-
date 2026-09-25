import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  advanceApprovalSchema,
  advancePaymentSchema,
  advanceQuerySchema,
  advanceRejectionSchema,
  advanceRequestSchema,
  advanceRescheduleSchema,
  approveAdvance,
  cancelAdvance,
  getAdvance,
  listAdvances,
  markAdvancePaid,
  rejectAdvance,
  requestAdvance,
  rescheduleAdvance,
} from './advances.service';

export const advancesRouter: Router = Router();

advancesRouter.use(authenticate);

/** Own advances for an employee, the whole scope for HR. Never a manager's team. */
advancesRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, advanceQuerySchema);
    const { items, meta, summary } = await listAdvances(requireAuth(req), query);
    res.json({ data: items, meta, summary });
  }),
);

advancesRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, advanceRequestSchema);
    sendCreated(res, await requestAdvance(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

advancesRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getAdvance(requireAuth(req), id));
  }),
);

advancesRouter.post(
  '/:id/approve',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, advanceApprovalSchema);
    sendData(res, await approveAdvance(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

advancesRouter.post(
  '/:id/reject',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { note } = parseBody(req, advanceRejectionSchema);
    sendData(res, await rejectAdvance(requireAuth(req), id, note, auditContextFromRequest(req)));
  }),
);

advancesRouter.post(
  '/:id/mark-paid',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, advancePaymentSchema);
    sendData(res, await markAdvancePaid(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

advancesRouter.post(
  '/:id/reschedule',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, advanceRescheduleSchema);
    sendData(res, await rescheduleAdvance(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

/** The employee withdraws a pending request; HR can cancel before pay-out. */
advancesRouter.post(
  '/:id/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await cancelAdvance(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);
