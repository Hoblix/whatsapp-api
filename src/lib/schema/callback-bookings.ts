import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

// Tracks the current callback booking per phone number.
// Upserted when the customer submits (or reschedules) their callback.
export const callbackBookingsTable = pgTable("callback_bookings", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  name: text("name"),
  bookedDate: text("booked_date").notNull(),       // ISO: "2026-04-17"
  bookedSlot: text("booked_slot").notNull(),       // e.g. "16-17"
  bookedSlotLabel: text("booked_slot_label"),      // e.g. "4:00 PM – 5:00 PM"
  status: text("status").notNull().default("scheduled"), // scheduled | rescheduled | completed | cancelled
  source: text("source"),                           // "lead_form" | "reschedule" | "manual"
  rescheduleCount: serial("reschedule_count"),     // auto-incremented by the handler
  lastRescheduledAt: timestamp("last_rescheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
