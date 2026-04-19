import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

// Dedupe log for automated "callback_missed" template sends.
// Key: (notion_page_id, trigger_status) — one send per page per status transition.
export const missedCallNotificationsTable = pgTable(
  "missed_call_notifications",
  {
    id: serial("id").primaryKey(),
    notionPageId: text("notion_page_id").notNull(),
    triggerStatus: text("trigger_status").notNull(),
    phoneNumber: text("phone_number").notNull(),
    waMessageId: text("wa_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePageStatus: unique().on(t.notionPageId, t.triggerStatus),
  }),
);
