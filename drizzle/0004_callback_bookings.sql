CREATE TABLE IF NOT EXISTS callback_bookings (
  id serial PRIMARY KEY,
  phone_number text NOT NULL UNIQUE,
  name text,
  booked_date text NOT NULL,
  booked_slot text NOT NULL,
  booked_slot_label text,
  status text NOT NULL DEFAULT 'scheduled',
  source text,
  reschedule_count serial,
  last_rescheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_callback_bookings_phone ON callback_bookings(phone_number);
