import { Prisma } from '@prisma/client';
import type { AuditAction } from '@prisma/client';
import type { Request } from 'express';
import { prisma, type TxClient } from '../db/prisma';
import { logger } from '../config/logger';
import type { AuthContext } from '../common/auth-context';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /**
   * Legal entity the audited record belongs to. Tagging it is what lets an
   * entity-scoped HR admin read their own trail without reading everyone's.
   */
  legalEntityId?: string | null;
  summary: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  actor?: AuthContext | null;
  /** Used when there is no authenticated actor yet, e.g. a failed login. */
  actorLabel?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Pulls the client fingerprint off the request for the trail. */
export function auditContextFromRequest(req: Request): Pick<AuditInput, 'ipAddress' | 'userAgent'> {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

/**
 * Writes one entry to the immutable audit trail.
 *
 * Pass the transaction client when the audited change happens inside a
 * transaction, so the record and its trail entry commit or roll back together -
 * an audit log that disagrees with the data is worse than none.
 *
 * Auditing never fails the operation it describes: if the write throws, it is
 * logged and swallowed rather than rolling back a legitimate business action.
 */
export async function recordAudit(input: AuditInput, client: TxClient = prisma): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        actorUserId: input.actor?.userId ?? null,
        actorLabel: input.actorLabel ?? (input.actor ? `${input.actor.email} (${input.actor.role})` : 'system'),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        legalEntityId: input.legalEntityId ?? null,
        summary: input.summary,
        before: input.before ?? Prisma.JsonNull,
        after: input.after ?? Prisma.JsonNull,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: error, entityType: input.entityType, entityId: input.entityId }, 'Failed to write audit log');
  }
}

type JsonRecord = Record<string, Prisma.InputJsonValue | null>;

/** Coerces an arbitrary field value into something the Json column can hold. */
function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  // Prisma relation payloads such as `{ connect: { id } }` land here.
  return JSON.stringify(value);
}

/**
 * Reduces a before/after pair to only the fields that actually changed, so the
 * trail stores the diff rather than two near-identical copies of the record.
 */
export function diffRecords<T extends Record<string, unknown>>(
  before: T,
  after: Partial<Record<keyof T | string, unknown>>,
): { before: JsonRecord; after: JsonRecord } | null {
  const changedBefore: JsonRecord = {};
  const changedAfter: JsonRecord = {};

  for (const [key, nextValue] of Object.entries(after)) {
    if (nextValue === undefined) continue;
    const previousValue = before[key];
    const same =
      previousValue instanceof Date && nextValue instanceof Date
        ? previousValue.getTime() === nextValue.getTime()
        : previousValue === nextValue;
    if (!same) {
      changedBefore[key] = toJsonValue(previousValue);
      changedAfter[key] = toJsonValue(nextValue);
    }
  }

  return Object.keys(changedAfter).length === 0 ? null : { before: changedBefore, after: changedAfter };
}
