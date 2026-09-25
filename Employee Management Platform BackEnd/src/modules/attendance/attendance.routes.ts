import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  attendanceListSchema,
  boardQuerySchema,
  checkInSchema,
  checkOutSchema,
  correctAttendanceSchema,
  manualAttendanceSchema,
  recalculateSchema,
  summaryQuerySchema,
  timesheetQuerySchema,
} from './attendance.schema';
import * as attendance from './attendance.service';

export const attendanceRouter: Router = Router();

attendanceRouter.use(authenticate);

// --- Self-service ------------------------------------------------------------
// Check-in and check-out always act on the caller's own record: there is no
// employee id in the request to tamper with, and the server clock decides the time.

attendanceRouter.post(
  '/check-in',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, checkInSchema);
    sendCreated(res, await attendance.checkIn(requireAuth(req), input));
  }),
);

attendanceRouter.post(
  '/check-out',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, checkOutSchema);
    sendData(res, await attendance.checkOut(requireAuth(req), input));
  }),
);

attendanceRouter.get(
  '/today',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, await attendance.getMyToday(requireAuth(req)));
  }),
);

// --- Reading -------------------------------------------------------------------
// Open to every role; the service limits the rows to self, direct reports, or
// HR's scope.

attendanceRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, attendanceListSchema);
    const { items, meta, totals } = await attendance.listAttendance(requireAuth(req), query);
    res.json({ data: items, meta, totals });
  }),
);

attendanceRouter.get(
  '/board',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, boardQuerySchema);
    sendData(res, await attendance.getBoard(requireAuth(req), query));
  }),
);

attendanceRouter.get(
  '/timesheet',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, timesheetQuerySchema);
    sendData(res, await attendance.getTimesheet(requireAuth(req), query));
  }),
);

attendanceRouter.get(
  '/summary',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, summaryQuerySchema);
    sendData(res, await attendance.getAttendanceSummary(requireAuth(req), query));
  }),
);

// --- HR corrections ------------------------------------------------------------

attendanceRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, manualAttendanceSchema);
    sendCreated(res, await attendance.createManualAttendance(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

attendanceRouter.post(
  '/recalculate',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, recalculateSchema);
    sendData(res, await attendance.recalculateAttendance(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

attendanceRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, correctAttendanceSchema);
    sendData(res, await attendance.correctAttendance(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);
