import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  createWorkLocation,
  describeCallerNetwork,
  getWorkforceDistribution,
  listWorkLocations,
  updateWorkLocation,
  updateWorkLocationSchema,
  workLocationSchema,
} from './work-locations.service';

const listQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const workLocationsRouter: Router = Router();

workLocationsRouter.use(authenticate);

workLocationsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, listQuerySchema);
    sendData(res, await listWorkLocations(requireAuth(req), query));
  }),
);

workLocationsRouter.get(
  '/distribution',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await getWorkforceDistribution(requireAuth(req)));
  }),
);

/**
 * The network this request comes from, as the API sees it. HR presses "Add the
 * network I'm on" while connected to the office Wi-Fi to register the office.
 */
workLocationsRouter.get(
  '/my-network',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, describeCallerNetwork(req.ip));
  }),
);

workLocationsRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, workLocationSchema);
    sendCreated(res, await createWorkLocation(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

workLocationsRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, updateWorkLocationSchema);
    sendData(res, await updateWorkLocation(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);
