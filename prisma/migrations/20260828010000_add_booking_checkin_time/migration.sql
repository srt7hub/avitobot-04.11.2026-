ALTER TABLE "Booking"
  ADD COLUMN "checkInTimeMinutes" INTEGER,
  ADD COLUMN "checkInTimeSource" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "checkInTimeMessage" TEXT NOT NULL DEFAULT '';
