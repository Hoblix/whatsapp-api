import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const templateMediaTable = pgTable("template_media", {
  templateName: text("template_name").primaryKey(),
  mediaUrl: text("media_url").notNull(),
  mediaType: text("media_type").notNull(), // "IMAGE" | "VIDEO" | "DOCUMENT"
  metaMediaId: text("meta_media_id"),       // Cached Meta media_id from /PHONE_NUMBER_ID/media upload
  metaMediaIdExpiresAt: timestamp("meta_media_id_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
