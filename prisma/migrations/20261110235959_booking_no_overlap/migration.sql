-- Database-level guarantee that two active bookings for the same equipment never overlap,
-- even under concurrent requests. Application code additionally enforces buffer time.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "equipmentId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING_APPROVAL', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW'));
