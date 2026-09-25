-- Pollux HR: attendance and overtime.
--
-- New tables only. Days without an event (absence, weekend, holiday) are not
-- stored; they are evaluated from the schedule when read.

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND', 'PARTIAL', 'MISSING_CHECKOUT');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('WEB', 'MOBILE', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AttendanceDayType" AS ENUM ('WORKING_DAY', 'WEEKEND', 'HOLIDAY', 'LEAVE');

-- CreateEnum
CREATE TYPE "OvertimeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OvertimeSource" AS ENUM ('ATTENDANCE', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ATTENDANCE_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYSLIP_ISSUED';

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "checkIn" TIMESTAMPTZ(3),
    "checkOut" TIMESTAMPTZ(3),
    "checkInSource" "AttendanceSource",
    "checkOutSource" "AttendanceSource",
    "dayType" "AttendanceDayType" NOT NULL DEFAULT 'WORKING_DAY',
    "scheduleId" TEXT,
    "scheduledStart" TIMESTAMPTZ(3),
    "scheduledEnd" TIMESTAMPTZ(3),
    "scheduledMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "absentDays" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "status" "AttendanceStatus" NOT NULL,
    "statusOverridden" BOOLEAN NOT NULL DEFAULT false,
    "source" "AttendanceSource" NOT NULL DEFAULT 'WEB',
    "notes" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "correctedById" TEXT,
    "correctedAt" TIMESTAMP(3),
    "correctionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_entries" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "attendanceId" TEXT,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "dayType" "AttendanceDayType" NOT NULL DEFAULT 'WORKING_DAY',
    "rateMultiplier" DECIMAL(4,2) NOT NULL,
    "status" "OvertimeStatus" NOT NULL DEFAULT 'PENDING',
    "source" "OvertimeSource" NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_records_workDate_idx" ON "attendance_records"("workDate");

-- CreateIndex
CREATE INDEX "attendance_records_legalEntityId_workDate_idx" ON "attendance_records"("legalEntityId", "workDate");

-- CreateIndex
CREATE INDEX "attendance_records_status_workDate_idx" ON "attendance_records"("status", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_employeeId_workDate_key" ON "attendance_records"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_entries_attendanceId_key" ON "overtime_entries"("attendanceId");

-- CreateIndex
CREATE INDEX "overtime_entries_employeeId_date_idx" ON "overtime_entries"("employeeId", "date");

-- CreateIndex
CREATE INDEX "overtime_entries_legalEntityId_status_date_idx" ON "overtime_entries"("legalEntityId", "status", "date");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

