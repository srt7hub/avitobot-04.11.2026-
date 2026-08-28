-- Данные инструкции хранятся у объекта, а отправка — отдельно у каждой брони.
ALTER TABLE "Property"
  ADD COLUMN "intercomCode" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "mapUrl" TEXT NOT NULL DEFAULT '';

CREATE TABLE "CheckinDispatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "approvalRequestedAt" TIMESTAMP(3),
  "deferredUntil" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "sentBy" TEXT NOT NULL DEFAULT '',
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CheckinDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CheckinDispatch_bookingId_key" ON "CheckinDispatch"("bookingId");
CREATE INDEX "CheckinDispatch_tenantId_scheduledFor_idx" ON "CheckinDispatch"("tenantId", "scheduledFor");

ALTER TABLE "CheckinDispatch"
  ADD CONSTRAINT "CheckinDispatch_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
