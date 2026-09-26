-- On-site check-in: a work location can require people to check in and out by
-- scanning its QR code, from inside a geofence and/or on the office network.
-- Additive only: every existing location keeps plain check-in.

-- AlterTable
ALTER TABLE "work_locations" ADD COLUMN     "allowedNetworks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "geofenceRadiusMeters" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "qrCheckInRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qrCode" TEXT,
ADD COLUMN     "wifiName" TEXT;

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "checkInVerification" JSONB,
ADD COLUMN     "checkOutVerification" JSONB;
