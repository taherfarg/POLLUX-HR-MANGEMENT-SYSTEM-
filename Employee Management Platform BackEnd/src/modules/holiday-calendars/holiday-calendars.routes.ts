import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  createHolidayCalendar,
  holidayCalendarSchema,
  listHolidayCalendars,
  updateHolidayCalendar,
  updateHolidayCalendarSchema,
} from './holiday-calendars.service';

/**
 * Holiday calendars. The holidays inside a calendar are managed through
 * `/leave/holidays`, which is where they always lived.
 */
export const holidayCalendarsRouter: Router = Router();

holidayCalendarsRouter.use(authenticate);

holidayCalendarsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await listHolidayCalendars(requireAuth(req)));
  }),
);

holidayCalendarsRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, holidayCalendarSchema);
    sendCreated(res, await createHolidayCalendar(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

holidayCalendarsRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, updateHolidayCalendarSchema);
    sendData(res, await updateHolidayCalendar(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);
