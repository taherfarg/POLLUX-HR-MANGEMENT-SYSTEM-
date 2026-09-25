-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "attendanceStartDate" DATE;

-- Backfill: companies that existed before attendance tracking start tracking
-- on the day of the upgrade, so no absence is inferred for the days before it
-- (and a first payroll after go-live does not deduct those days).
UPDATE "company_settings" SET "attendanceStartDate" = CURRENT_DATE WHERE "attendanceStartDate" IS NULL;
