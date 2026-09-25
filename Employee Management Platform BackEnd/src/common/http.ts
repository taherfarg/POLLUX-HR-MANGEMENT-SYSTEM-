import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

/**
 * Every successful response is `{ data, meta? }` and every failure is
 * `{ error: { code, message, details? } }`. A single predictable envelope means
 * the frontend writes one response handler instead of one per endpoint.
 */
export function sendData<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data });
}

export function sendCreated<T>(res: Response, data: T): Response {
  return res.status(201).json({ data });
}

/**
 * Sends a stored file. The name is reduced to a safe character set before it
 * goes into a header, and sensitive files (payslips, exports) are never cached
 * by the browser or a proxy.
 */
export function sendFile(
  res: Response,
  file: { fileName: string; mimeType: string; data: Buffer },
  asAttachment = false,
): Response {
  const safeName = file.fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 150) || 'file';
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(file.data.length));
  res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(file.data);
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function sendPage<T>(res: Response, items: T[], meta: PageMeta): Response {
  return res.status(200).json({ data: items, meta });
}

export function buildPageMeta(page: number, pageSize: number, total: number): PageMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

/** Shared pagination inputs. Mix into any list endpoint query schema. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function toSkipTake(input: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler. Without this, an await that throws becomes an unhandled rejection and
 * the client is left hanging until timeout.
 */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
