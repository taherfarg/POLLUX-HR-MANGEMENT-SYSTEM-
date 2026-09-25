-- Pollux HR: payroll line sources and per-employee attendance tracking.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "attendanceTracked" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "payroll_items" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- CreateIndex
CREATE INDEX "payroll_items_sourceType_sourceId_idx" ON "payroll_items"("sourceType", "sourceId");

