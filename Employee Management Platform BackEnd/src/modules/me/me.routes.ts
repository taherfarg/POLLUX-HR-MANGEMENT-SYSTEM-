import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendData } from '../../common/http';
import { parseQuery } from '../../common/validate';
import { authenticate, requireAuth } from '../../middleware/authenticate';
import { ForbiddenError } from '../../common/errors';
import { getDashboard } from '../dashboard/dashboard.service';
import { listEmployeeDocuments } from '../documents/documents.service';
import { getLeaveBalances } from '../leave/leave.service';
import { getDirectReports, getEmployee, getEmployeeTimeline } from '../employees/employees.service';
import { listRequests } from '../requests/requests.service';
import { requestQuerySchema } from '../requests/requests.schema';
import { getMyToday, getTimesheet } from '../attendance/attendance.service';
import { timesheetQuerySchema } from '../attendance/attendance.schema';

export const meRouter: Router = Router();

meRouter.use(authenticate);

/**
 * Self-service endpoints.
 *
 * Every route here resolves the employee id from the access token rather than
 * from the URL. There is no id to tamper with, which is the simplest possible
 * guarantee that one employee cannot read another's data through this surface.
 */
function selfEmployeeId(req: Request): string {
  const auth = requireAuth(req);
  if (!auth.employeeId) {
    throw new ForbiddenError('This account is not linked to an employee record');
  }
  return auth.employeeId;
}

meRouter.get(
  '/dashboard',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await getDashboard(requireAuth(req)));
  }),
);

meRouter.get(
  '/profile',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    sendData(res, await getEmployee(auth, selfEmployeeId(req)));
  }),
);

meRouter.get(
  '/timeline',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await getEmployeeTimeline(selfEmployeeId(req), { includeCompensation: true }));
  }),
);

meRouter.get(
  '/leave-balances',
  asyncHandler(async (req: Request, res: Response) => {
    const year = Number(req.query.year ?? new Date().getUTCFullYear());
    sendData(
      res,
      await getLeaveBalances(selfEmployeeId(req), Number.isNaN(year) ? new Date().getUTCFullYear() : year),
    );
  }),
);

meRouter.get(
  '/documents',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    sendData(res, await listEmployeeDocuments(auth, selfEmployeeId(req)));
  }),
);

meRouter.get(
  '/requests',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    const query = parseQuery(req, requestQuerySchema);
    // Forced to the caller's own employee id regardless of what was passed in.
    const { items, meta, summary } = await listRequests(auth, { ...query, employeeId: selfEmployeeId(req) });
    res.json({ data: items, meta, summary });
  }),
);

/** A manager's own team view, without needing to know their employee id. */
meRouter.get(
  '/team',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    sendData(res, await getDirectReports(selfEmployeeId(req), auth));
  }),
);

/** The caller's own attendance for a range (defaults to this month). */
meRouter.get(
  '/attendance',
  asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    const query = parseQuery(req, timesheetQuerySchema);
    // Forced to the caller's own employee id regardless of what was passed in.
    sendData(res, await getTimesheet(auth, { ...query, employeeId: selfEmployeeId(req) }));
  }),
);

meRouter.get(
  '/attendance/today',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await getMyToday(requireAuth(req)));
  }),
);
