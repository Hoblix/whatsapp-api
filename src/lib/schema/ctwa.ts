import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { conversationsTable } from "./conversations";

// ── CTWA Rules ────────────────────────────────────────────────────────────────
// Each rule defines a trigger condition (which ads to match) and an action
// (which template or flow to send automatically when the ad fires).
export const ctwaRulesTable = pgTable(
  "ctwa_rules",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    matchType: text("match_type", {
      enum: ["any", "ad_id", "source_url_contains"],
    }).notNull().default("any"),
    matchValue: text("match_value"),
    actionType: text("action_type", {
      enum: ["template", "flow"],
    }).notNull(),
    actionConfig: jsonb("action_config").notNull(),
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ctwa_rules_priority_active_idx").on(t.priority, t.isActive),
  ],
);

// ── CTWA Events ───────────────────────────────────────────────────────────────
// Attribution log — one row per inbound ad-triggered WhatsApp message.
// Keyed by (phone_number, ad_id) for 24h idempotency guard.
export const ctwaEventsTable = pgTable(
  "ctwa_events",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversationsTable.id),
    phoneNumber: text("phone_number").notNull(),
    adId: text("ad_id"),
    adSourceUrl: text("ad_source_url"),
    adHeadline: text("ad_headline"),
    adBody: text("ad_body"),
    adMediaType: text("ad_media_type"),
    ruleId: integer("rule_id").references(() => ctwaRulesTable.id),
    actionFired: boolean("action_fired").notNull().default(false),
    rawReferral: jsonb("raw_referral"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ctwa_events_phone_ad_created_idx").on(t.phoneNumber, t.adId, t.createdAt),
  ],
);

export type CTWARule = typeof ctwaRulesTable.$inferSelect;
export type InsertCTWARule = typeof ctwaRulesTable.$inferInsert;
export type CTWAEvent = typeof ctwaEventsTable.$inferSelect;
export type InsertCTWAEvent = typeof ctwaEventsTable.$inferInsert;

export type TemplateActionConfig = {
  templateName: string;
  languageCode: string;
  components?: any[];
};

export type FlowActionConfig = {
  flowDbId: number;
  flowToken?: string;
  ctaText: string;
  messageBody: string;
  header?: string;
};
