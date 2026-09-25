import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendData, sendFile } from '../../common/http';
import { idParamSchema, parseParams } from '../../common/validate';
import { authenticate, requireAdmin, requireAuth } from '../../middleware/authenticate';
import { auditContextFromRequest } from '../../services/audit.service';
import { deleteEmployeeDocument, downloadDocumentFile, getDocumentContent } from './documents.service';

/**
 * Documents are created and listed under `/employees/:id/documents`, where they
 * belong. Deleting only needs the document id, so it lives here.
 */
export const documentsRouter: Router = Router();

documentsRouter.use(authenticate);

/** Letter body. Open to the employee it belongs to, and to HR within scope. */
documentsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    sendData(res, await getDocumentContent(requireAuth(req), id));
  }),
);

/** Stored bytes (payslip PDFs). Same access rule as reading the document. */
documentsRouter.get(
  '/:id/download',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    const file = await downloadDocumentFile(requireAuth(req), id, auditContextFromRequest(req));
    sendFile(res, file, req.query.download === '1');
  }),
);

documentsRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = parseParams(req, idParamSchema);
    await deleteEmployeeDocument(requireAuth(req), id, auditContextFromRequest(req));
    res.status(204).send();
  }),
);
