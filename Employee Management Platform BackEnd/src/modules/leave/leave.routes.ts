import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, optionalTrimmedString, parseBody, parseParams, parseQuery, toUtcDate } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  calendarQuerySchema,
  createHoliday,
  createLeaveType,
  deleteHoliday,
  getLeaveCalendar,
  holidaySchema,
  leaveTypeSchema,
  listHolidays,
  listLeaveTypes,
  updateHoliday,
  updateHolidaySchema,
  updateLeaveType,
} from './leave.service';
import {
  adjustBalance,
  balanceAdjustSchema,
  balanceGenerateSchema,
  balanceQuerySchema,
  generateBalances,
  listBalances,
} from './leave-balances.service';

export const leaveRouter: Router = Router();

leaveRouter.use(authenticate);

const leaveTypeQuerySchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const holidayQuerySchema = z.object({
  legalEntityId: optionalTrimmedString(40),
  calendarId: optionalTrimmedString(40),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
});

leaveRouter.get(
  '/types',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, leaveTypeQuerySchema);
    sendData(res, await listLeaveTypes(requireAuth(req), query));
  }),
);

leaveRouter.post(
  '/types',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, leaveTypeSchema);
    sendCreated(res, await createLeaveType(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

leaveRouter.patch(
  '/types/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, leaveTypeSchema.partial());
    sendData(res, await updateLeaveType(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

leaveRouter.get(
  '/holidays',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, holidayQuerySchema);
    sendData(res, await listHolidays(requireAuth(req), query));
  }),
);

leaveRouter.post(
  '/holidays',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, holidaySchema);
    sendCreated(res, await createHoliday(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

leaveRouter.patch(
  '/holidays/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, updateHolidaySchema);
    sendData(res, await updateHoliday(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

leaveRouter.delete(
  '/holidays/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    await deleteHoliday(requireAuth(req), id, auditContextFromRequest(req));
    res.status(204).send();
  }),
);

/**
 * Shared absence calendar. Everyone can see who is away; the stated reason is
 * filtered out for colleagues in the service.
 */
leaveRouter.get(
  '/calendar',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, calendarQuerySchema);
    sendData(
      res,
      await getLeaveCalendar(requireAuth(req), {
        from: toUtcDate(query.from),
        to: toUtcDate(query.to),
        legalEntityId: query.legalEntityId,
      }),
    );
  }),
);

// --- Leave balances -------------------------------------------------------------

/** HR: everyone in scope. A manager: their team. An employee: their own. */
leaveRouter.get(
  '/balances',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, balanceQuerySchema);
    const { items, meta, totals } = await listBalances(requireAuth(req), query);
    res.json({ data: items, meta, totals });
  }),
);

leaveRouter.post(
  '/balances/generate',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, balanceGenerateSchema);
    sendData(res, await generateBalances(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

leaveRouter.patch(
  '/balances/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, balanceAdjustSchema);
    sendData(res, await adjustBalance(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);
