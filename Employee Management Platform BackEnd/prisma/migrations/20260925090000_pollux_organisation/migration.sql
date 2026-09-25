-- Pollux HR: organisation structure.
--
-- Adds company settings, work locations, work schedules and holiday calendars,
-- and the employee fields that point at them. Everything is additive. Existing
-- holidays are moved into one calendar per legal entity, and every entity gets
-- a settings row, so an existing database migrates with no data loss.

-- CreateEnum
CREATE TYPE "WorkLocationKind" AS ENUM ('OFFICE', 'REMOTE', 'FIELD', 'OTHER');

-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('PUBLIC', 'COMPANY');

-- CreateEnum
CREATE TYPE "SalaryDayBasis" AS ENUM ('FIXED_30', 'CALENDAR_DAYS', 'WORKING_DAYS');

-- CreateEnum
CREATE TYPE "PayBase" AS ENUM ('BASIC', 'GROSS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CALCULATE';
ALTER TYPE "AuditAction" ADD VALUE 'REVIEW';
ALTER TYPE "AuditAction" ADD VALUE 'MARK_PAID';
ALTER TYPE "AuditAction" ADD VALUE 'REOPEN';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT';

-- AlterEnum
ALTER TYPE "WorkMode" ADD VALUE 'FIELD';

-- DropIndex
DROP INDEX "holidays_legalEntityId_date_key";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "legalEntityId" TEXT;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "holidayCalendarId" TEXT,
ADD COLUMN     "overtimeEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timezone" TEXT,
ADD COLUMN     "workCity" TEXT,
ADD COLUMN     "workCountry" TEXT,
ADD COLUMN     "workCountryCode" CHAR(2),
ADD COLUMN     "workLocationId" TEXT,
ADD COLUMN     "workScheduleId" TEXT;

-- AlterTable
ALTER TABLE "holidays" ADD COLUMN     "calendarId" TEXT,
ADD COLUMN     "type" "HolidayType" NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "company_settings" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "employeeNumberPrefix" TEXT,
    "defaultWorkScheduleId" TEXT,
    "defaultHolidayCalendarId" TEXT,
    "lateGraceMinutes" INTEGER NOT NULL DEFAULT 10,
    "earlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 10,
    "partialDayThresholdPercent" INTEGER NOT NULL DEFAULT 50,
    "missingCheckoutAfterMinutes" INTEGER NOT NULL DEFAULT 120,
    "overtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overtimeRequiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "minOvertimeMinutes" INTEGER NOT NULL DEFAULT 30,
    "countEarlyArrivalAsOvertime" BOOLEAN NOT NULL DEFAULT false,
    "overtimeRateMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.25,
    "restDayOvertimeMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.50,
    "overtimeBase" "PayBase" NOT NULL DEFAULT 'BASIC',
    "standardDailyHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "payrollDay" INTEGER NOT NULL DEFAULT 28,
    "salaryDayBasis" "SalaryDayBasis" NOT NULL DEFAULT 'FIXED_30',
    "deductionBase" "PayBase" NOT NULL DEFAULT 'BASIC',
    "absenceDeductionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "unpaidLeaveDeductionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lateDeductionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payrollRequiresSeparateApprover" BOOLEAN NOT NULL DEFAULT true,
    "maxAdvanceAmount" DECIMAL(12,2),
    "maxAdvanceInstallments" INTEGER NOT NULL DEFAULT 12,
    "allowConcurrentAdvances" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_locations" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WorkLocationKind" NOT NULL DEFAULT 'OFFICE',
    "addressLine" TEXT,
    "city" TEXT,
    "countryCode" CHAR(2),
    "countryName" TEXT,
    "timezone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedule_days" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL DEFAULT true,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_schedule_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendars" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" CHAR(2),
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- Backfill: one holiday calendar per existing legal entity, holding that
-- entity's existing holidays. Deterministic ids keep the backfill idempotent
-- to reason about and make the rows easy to find afterwards.
INSERT INTO "holiday_calendars" ("id", "legalEntityId", "code", "name", "countryCode", "description", "isActive", "createdAt", "updatedAt")
SELECT 'hcal_' || le."id", le."id", le."code" || '-HOLIDAYS', le."name" || ' Public Holidays', le."countryCode",
       'Created from the holidays recorded against ' || le."name" || '.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "legal_entities" le;

UPDATE "holidays" SET "calendarId" = 'hcal_' || "legalEntityId";

ALTER TABLE "holidays" ALTER COLUMN "calendarId" SET NOT NULL;

-- Backfill: a settings row per legal entity with the default policy values.
-- The oldest active entity becomes the primary company.
INSERT INTO "company_settings" ("id", "legalEntityId", "isPrimary", "displayName", "defaultHolidayCalendarId", "createdAt", "updatedAt")
SELECT 'cs_' || le."id", le."id",
       le."id" = (SELECT p."id" FROM "legal_entities" p WHERE p."isActive" ORDER BY p."establishedOn" ASC, p."createdAt" ASC LIMIT 1),
       le."name", 'hcal_' || le."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "legal_entities" le;

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_legalEntityId_key" ON "company_settings"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "work_locations_code_key" ON "work_locations"("code");

-- CreateIndex
CREATE INDEX "work_locations_legalEntityId_idx" ON "work_locations"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_code_key" ON "work_schedules"("code");

-- CreateIndex
CREATE INDEX "work_schedules_legalEntityId_idx" ON "work_schedules"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "work_schedule_days_scheduleId_dayOfWeek_key" ON "work_schedule_days"("scheduleId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_calendars_code_key" ON "holiday_calendars"("code");

-- CreateIndex
CREATE INDEX "holiday_calendars_legalEntityId_idx" ON "holiday_calendars"("legalEntityId");

-- CreateIndex
CREATE INDEX "audit_logs_legalEntityId_createdAt_idx" ON "audit_logs"("legalEntityId", "createdAt");

-- CreateIndex
CREATE INDEX "employees_workLocationId_idx" ON "employees"("workLocationId");

-- CreateIndex
CREATE INDEX "employees_workScheduleId_idx" ON "employees"("workScheduleId");

-- CreateIndex
CREATE INDEX "holidays_legalEntityId_date_idx" ON "holidays"("legalEntityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendarId_date_key" ON "holidays"("calendarId", "date");

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_defaultWorkScheduleId_fkey" FOREIGN KEY ("defaultWorkScheduleId") REFERENCES "work_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_defaultHolidayCalendarId_fkey" FOREIGN KEY ("defaultHolidayCalendarId") REFERENCES "holiday_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedule_days" ADD CONSTRAINT "work_schedule_days_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "work_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_workScheduleId_fkey" FOREIGN KEY ("workScheduleId") REFERENCES "work_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_holidayCalendarId_fkey" FOREIGN KEY ("holidayCalendarId") REFERENCES "holiday_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
