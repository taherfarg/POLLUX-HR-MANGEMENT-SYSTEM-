import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData } from '../../common/http';
import { optionalTrimmedString, parseBody, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import { companySettingsUpdateSchema } from './settings.schema';
import { getPublicBranding, getSettings, updateSettings } from './settings.service';

const entityQuerySchema = z.object({ legalEntityId: optionalTrimmedString(40) });

export const settingsRouter: Router = Router();

settingsRouter.use(authenticate);

/** Public subset for everyone; the full policy for HR and administrators. */
settingsRouter.get(
  '/company',
  asyncHandler(async (req: Request, res: Response) => {
    const { legalEntityId } = parseQuery(req, entityQuerySchema);
    sendData(res, await getSettings(requireAuth(req), legalEntityId));
  }),
);

/** ADMIN only - enforced again in the service. */
settingsRouter.patch(
  '/company',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { legalEntityId } = parseQuery(req, entityQuerySchema);
    const input = parseBody(req, companySettingsUpdateSchema);
    sendData(res, await updateSettings(requireAuth(req), input, auditContextFromRequest(req), legalEntityId));
  }),
);

/** Unauthenticated: the login screen shows the company name and logo. */
export const publicRouter: Router = Router();

publicRouter.get(
  '/branding',
  asyncHandler(async (_req: Request, res: Response) => {
    sendData(res, await getPublicBranding());
  }),
);
