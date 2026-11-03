-- The HR assistant: each question asked is kept in the audit trail.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'AI_QUERY';
