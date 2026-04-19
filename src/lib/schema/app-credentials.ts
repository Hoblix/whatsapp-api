import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appCredentialsTable = pgTable("app_credentials", {
  key: text("key").primaryKey(),
  encryptedValue: text("encrypted_value").notNull(),
  category: text("category").notNull().default("general"),
  label: text("label").notNull().default(""),
  description: text("description"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
