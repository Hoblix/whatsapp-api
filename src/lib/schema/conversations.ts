import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  contactName: text("contact_name"),
  email: text("email"),
  notes: text("notes"),
  tags: text("tags"),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  unreadCount: integer("unread_count").notNull().default(0),
  adReferral: jsonb("ad_referral"),
  adSource: text("ad_source"),
  sourceType: text("source_type").default("organic"),
  sourcePlatform: text("source_platform"),
  campaignName: text("campaign_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
  waMessageId: text("wa_message_id"),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  messageType: text("message_type", {
    enum: ["text", "image", "audio", "video", "document", "sticker", "location", "contacts", "reaction", "unsupported"],
  }).notNull().default("text"),
  body: text("body"),
  mediaUrl: text("media_url"),
  status: text("status"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  rawPayload: jsonb("raw_payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
