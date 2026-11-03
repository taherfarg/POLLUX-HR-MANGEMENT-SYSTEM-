import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { asyncHandler, sendData } from '../../common/http';
import { parseBody } from '../../common/validate';
import { authenticate, requireAuth, requireRole } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import { askAssistant, askSchema, assistantStatus } from './assistant.service';

export const assistantRouter: Router = Router();

assistantRouter.use(authenticate, requireRole('ADMIN', 'HR_ADMIN', 'MANAGER'));

/** Each question costs a model call; this caps what one person can run up in an hour. */
const questionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.AI_ASSISTANT_HOURLY_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${req.auth?.userId ?? req.ip ?? 'unknown'}`,
  skip: () => env.isTest,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: `You have asked ${env.AI_ASSISTANT_HOURLY_LIMIT} questions in the last hour. Please try again a little later.` },
  },
});

/** Whether the assistant is set up, so the page can say so instead of failing. */
assistantRouter.get(
  '/status',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, assistantStatus(requireAuth(req)));
  }),
);

assistantRouter.post(
  '/ask',
  questionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, askSchema);
    sendData(res, await askAssistant(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);
