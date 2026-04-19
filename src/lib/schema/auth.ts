import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const allowedUsersTable = pgTable("allowed_users", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  role: text("role").notNull().default("user"), // "super_admin" | "user"
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const otpCodesTable = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  otpHash: text("otp_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSessionsTable = pgTable("auth_sessions", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  phoneNumber: text("phone_number").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),       // SHA-256 hash of the actual key
  keyPrefix: text("key_prefix"),             // first 12 chars of raw key for display
  name: text("name").notNull().default("Default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// IP allowlist — when non-empty, API key requests must originate from a listed IP.
// Cookie-based dashboard sessions are not IP-restricted.
export const ipAllowlistTable = pgTable("ip_allowlist", {
  id: serial("id").primaryKey(),
  ip: text("ip").notNull().unique(),         // exact IPv4/IPv6 address or CIDR string
  label: text("label"),                      // human-friendly name, e.g. "Production server"
  enabled: boolean("enabled").notNull().default(true),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
