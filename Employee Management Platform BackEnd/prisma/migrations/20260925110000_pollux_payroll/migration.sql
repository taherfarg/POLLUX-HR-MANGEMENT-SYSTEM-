-- Pollux HR: salary advances, payroll, payroll adjustments and stored
-- document files (payslip PDFs). New tables, plus a nullable link from
-- overtime entries to the payroll line that paid them.

-- CreateEnum
CREATE TYPE "SalaryAdvanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdvanceInstallmentStatus" AS ENUM ('SCHEDULED', 'DEDUCTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollItemKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollItemType" AS ENUM ('BASIC_SALARY', 'HOUSING_ALLOWANCE', 'TRANSPORT_ALLOWANCE', 'OTHER_ALLOWANCE', 'OVERTIME', 'BONUS', 'COMMISSION', 'ALLOWANCE', 'OTHER_EARNING', 'ADVANCE_DEDUCTION', 'UNPAID_LEAVE', 'ABSENCE', 'LATE_DEDUCTION', 'OTHER_DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentType" AS ENUM ('BONUS', 'COMMISSION', 'ALLOWANCE', 'DEDUCTION', 'ABSENCE', 'UNPAID_LEAVE', 'ADVANCE', 'OVERTIME', 'OTHER');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "overtime_entries" ADD COLUMN     "payrollItemId" TEXT;

-- CreateTable
CREATE TABLE "document_files" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advances" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "requestedAmount" DECIMAL(12,2) NOT NULL,
    "requestedInstallments" INTEGER,
    "approvedAmount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "requestDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repaymentStartDate" DATE,
    "installmentAmount" DECIMAL(12,2),
    "numberOfInstallments" INTEGER,
    "remainingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "SalaryAdvanceStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentReference" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advance_installments" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueMonth" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "AdvanceInstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "payrollItemId" TEXT,
    "deductedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_advance_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "payDate" DATE,
    "currency" CHAR(3) NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentReference" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "reopenReason" TEXT,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_records" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "departmentName" TEXT,
    "workLocationName" TEXT,
    "currency" CHAR(3) NOT NULL,
    "compensationRecordId" TEXT,
    "baseSalary" DECIMAL(12,2) NOT NULL,
    "housingAllowance" DECIMAL(12,2) NOT NULL,
    "transportAllowance" DECIMAL(12,2) NOT NULL,
    "otherAllowances" DECIMAL(12,2) NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "employedFraction" DECIMAL(6,4) NOT NULL,
    "workingDays" INTEGER NOT NULL,
    "absentDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "unpaidLeaveDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "dailyRate" DECIMAL(12,4) NOT NULL,
    "hourlyRate" DECIMAL(12,4) NOT NULL,
    "grossEarnings" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "netSalary" DECIMAL(12,2) NOT NULL,
    "warnings" TEXT[],
    "payslipDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "kind" "PayrollItemKind" NOT NULL,
    "type" "PayrollItemType" NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "rate" DECIMAL(12,4),
    "amount" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "payrollMonth" DATE NOT NULL,
    "type" "PayrollAdjustmentType" NOT NULL,
    "kind" "PayrollItemKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PayrollAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "payrollItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_files_documentId_key" ON "document_files"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_reference_key" ON "salary_advances"("reference");

-- CreateIndex
CREATE INDEX "salary_advances_employeeId_status_idx" ON "salary_advances"("employeeId", "status");

-- CreateIndex
CREATE INDEX "salary_advances_legalEntityId_status_idx" ON "salary_advances"("legalEntityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advance_installments_payrollItemId_key" ON "salary_advance_installments"("payrollItemId");

-- CreateIndex
CREATE INDEX "salary_advance_installments_dueMonth_status_idx" ON "salary_advance_installments"("dueMonth", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advance_installments_advanceId_sequence_key" ON "salary_advance_installments"("advanceId", "sequence");

-- CreateIndex
CREATE INDEX "payroll_periods_status_idx" ON "payroll_periods"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_legalEntityId_year_month_key" ON "payroll_periods"("legalEntityId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_records_payslipDocumentId_key" ON "payroll_records"("payslipDocumentId");

-- CreateIndex
CREATE INDEX "payroll_records_employeeId_idx" ON "payroll_records"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_records_periodId_employeeId_key" ON "payroll_records"("periodId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_items_recordId_idx" ON "payroll_items"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_adjustments_payrollItemId_key" ON "payroll_adjustments"("payrollItemId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_employeeId_payrollMonth_idx" ON "payroll_adjustments"("employeeId", "payrollMonth");

-- CreateIndex
CREATE INDEX "payroll_adjustments_legalEntityId_payrollMonth_status_idx" ON "payroll_adjustments"("legalEntityId", "payrollMonth", "status");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_entries_payrollItemId_key" ON "overtime_entries"("payrollItemId");

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advance_installments" ADD CONSTRAINT "salary_advance_installments_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "salary_advances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advance_installments" ADD CONSTRAINT "salary_advance_installments_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_payslipDocumentId_fkey" FOREIGN KEY ("payslipDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "payroll_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

