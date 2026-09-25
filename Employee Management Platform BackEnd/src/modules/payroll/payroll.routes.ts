import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendCreated, sendData, sendFile } from '../../common/http';
import { idParamSchema, parseBody, parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import {
  adjustmentDecisionSchema,
  adjustmentQuerySchema,
  adjustmentRejectionSchema,
  adjustmentSchema,
  approveAdjustment,
  cancelAdjustment,
  createAdjustment,
  listAdjustments,
  rejectAdjustment,
} from './adjustments.service';
import {
  approvePeriod,
  calculatePeriod,
  cancelPeriod,
  cancelPeriodSchema,
  createPeriod,
  createPeriodSchema,
  getPayslipPdf,
  getPeriod,
  getRecord,
  listPayslips,
  listPeriods,
  markPaidSchema,
  markPeriodPaid,
  payslipQuerySchema,
  periodQuerySchema,
  reopenPeriod,
  reopenSchema,
  reviewPeriod,
} from './payroll.service';

/**
 * Payroll runs and adjustments. Everything under `/payroll` is HR and
 * administrators only - the router gate is a first line, the services check
 * entity scope, four-eyes and period status again.
 */
export const payrollRouter: Router = Router();

payrollRouter.use(authenticate);

// --- Adjustments: bonuses, commissions, allowances and deductions -------------

payrollRouter.get(
  '/adjustments',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, adjustmentQuerySchema);
    const { items, meta, summary } = await listAdjustments(requireAuth(req), query);
    res.json({ data: items, meta, summary });
  }),
);

payrollRouter.post(
  '/adjustments',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, adjustmentSchema);
    sendCreated(res, await createAdjustment(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/adjustments/:id/approve',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { note } = parseBody(req, adjustmentDecisionSchema);
    sendData(res, await approveAdjustment(requireAuth(req), id, note, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/adjustments/:id/reject',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { note } = parseBody(req, adjustmentRejectionSchema);
    sendData(res, await rejectAdjustment(requireAuth(req), id, note, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/adjustments/:id/cancel',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await cancelAdjustment(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

// --- Payroll periods -----------------------------------------------------------

payrollRouter.get(
  '/periods',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, periodQuerySchema);
    sendData(res, await listPeriods(requireAuth(req), query));
  }),
);

payrollRouter.post(
  '/periods',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody(req, createPeriodSchema);
    sendCreated(res, await createPeriod(requireAuth(req), input, auditContextFromRequest(req)));
  }),
);

payrollRouter.get(
  '/periods/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getPeriod(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/periods/:id/calculate',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await calculatePeriod(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/periods/:id/review',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await reviewPeriod(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/periods/:id/approve',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await approvePeriod(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/periods/:id/mark-paid',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const input = parseBody(req, markPaidSchema);
    sendData(res, await markPeriodPaid(requireAuth(req), id, input, auditContextFromRequest(req)));
  }),
);

/** ADMIN only - enforced in the service, since HR_ADMIN passes requireAdmin. */
payrollRouter.post(
  '/periods/:id/reopen',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { reason } = parseBody(req, reopenSchema);
    sendData(res, await reopenPeriod(requireAuth(req), id, reason, auditContextFromRequest(req)));
  }),
);

payrollRouter.post(
  '/periods/:id/cancel',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { reason } = parseBody(req, cancelPeriodSchema);
    sendData(res, await cancelPeriod(requireAuth(req), id, reason, auditContextFromRequest(req)));
  }),
);

// --- One employee's payroll line -------------------------------------------------

/** Not role-gated: the employee may read their own approved line. */
payrollRouter.get(
  '/records/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getRecord(requireAuth(req), id, auditContextFromRequest(req)));
  }),
);

/**
 * Payslips: the caller's own, or anyone's in scope for HR. Kept apart from
 * `/payroll` because every employee uses it.
 */
export const payslipsRouter: Router = Router();

payslipsRouter.use(authenticate);

payslipsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseQuery(req, payslipQuerySchema);
    sendData(res, await listPayslips(requireAuth(req), query));
  }),
);

payslipsRouter.get(
  '/:id/pdf',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const { fileName, data } = await getPayslipPdf(requireAuth(req), id, auditContextFromRequest(req));
    sendFile(res, { fileName, mimeType: 'application/pdf', data }, req.query.download === '1');
  }),
);
