import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const backupsTable = pgTable("backups", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  totalConversations: integer("total_conversations").notNull().default(0),
  totalMessages: integer("total_messages").notNull().default(0),
  encrypted: boolean("encrypted").notNull().default(true),
  status: text("status", { enum: ["pending", "completed", "failed"] }).notNull().default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
