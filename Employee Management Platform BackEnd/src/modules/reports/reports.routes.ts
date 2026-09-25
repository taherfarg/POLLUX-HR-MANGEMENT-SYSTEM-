import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData, sendFile } from '../../common/http';
import { parseParams, parseQuery } from '../../common/validate';
import { authenticate, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import { toCsv, toPdf, toXlsx } from './report.export';
import { listReports, REPORT_TYPES, reportQuerySchema, runReport } from './reports.service';

/**
 * `GET /reports` lists the reports the caller may run; `GET /reports/:type`
 * runs one as JSON, or as a CSV, Excel or PDF download with `format=`.
 * Access is decided per report in the service.
 */
export const reportsRouter: Router = Router();

reportsRouter.use(authenticate);

reportsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    sendData(res, listReports(requireAuth(req)));
  }),
);

const typeParamSchema = z.object({ type: z.enum(REPORT_TYPES) });

const MIME_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

reportsRouter.get(
  '/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const { type } = parseParams(req, typeParamSchema);
    const query = parseQuery(req, reportQuerySchema);
    const report = await runReport(requireAuth(req), type, query, auditContextFromRequest(req));

    if (query.format === 'json') {
      sendData(res, report);
      return;
    }
    const data = query.format === 'csv' ? toCsv(report) : query.format === 'xlsx' ? await toXlsx(report) : await toPdf(report);
    const stamp = report.generatedAt.toISOString().slice(0, 10);
    sendFile(res, { fileName: `pollux-${type}-report-${stamp}.${query.format}`, mimeType: MIME_TYPES[query.format], data }, true);
  }),
);
