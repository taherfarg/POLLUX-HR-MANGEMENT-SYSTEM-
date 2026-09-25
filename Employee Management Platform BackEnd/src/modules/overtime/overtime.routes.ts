import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  approveOvertime,
  cancelOvertime,
  createManualOvertime,
  listOvertime,
  manualOvertimeSchema,
  overtimeDecisionSchema,
  overtimeQuerySchema,
  overtimeRejectionSchema,
  rejectOvertime,
} from './overtime.service';

export const overtimeRouter: Router = Router();

overtimeRouter.use(authenticate);

/** Own overtime, a manager's team, or HR's scope - decided in the service. */
overtimeRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, overtimeQuerySchema);
    const { items, meta, summary } = await listOvertime(requireAuth(req), query);
    res.json({ data: items, meta, summary });
  }),
);

overtimeRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, manualOvertimeSchema);
    sendCreated(res, await createManualOvertime(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

// Deciding is not role-gated at the router: a line manager may decide their
// team's overtime minutes. assertCanDecideOvertime makes the real decision.
overtimeRouter.post(
  '/:id/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { note } = parseBody(req, overtimeDecisionSchema);
    sendData(res, await approveOvertime(requireAuth(req), id, note, auditContextFromRequest(req)));
  }),
);

overtimeRouter.post(
  '/:id/reject',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { note } = parseBody(req, overtimeRejectionSchema);
    sendData(res, await rejectOvertime(requireAuth(req), id, note, auditContextFromRequest(req)));
  }),
);

overtimeRouter.post(
  '/:id/cancel',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await cancelOvertime(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);
