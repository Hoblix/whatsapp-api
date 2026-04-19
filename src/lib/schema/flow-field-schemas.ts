import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── FlowFieldEntry ───────────────────────────────────────────────────────────
// Represents a single field extracted from a WhatsApp Flow's JSON definition.
// This is the normalized shape stored in the `fields` JSONB column.
export interface FlowFieldEntry {
  field_key: string;
  label: string;
  type: string;
  values: string[];
  screen_id: string;
}

// ── Flow Field Schemas ───────────────────────────────────────────────────────
// Versioned store for normalized flow field definitions.
// Each row captures the complete field schema for a specific flow version.
// Multiple versions per flow_id are stored and retrievable independently.
export const flowFieldSchemasTable = pgTable(
  "flow_field_schemas",
  {
    id: serial("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    flowVersion: text("flow_version").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    fields: jsonb("fields").notNull().$type<FlowFieldEntry[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_field_schemas_flow_version_idx").on(t.flowId, t.flowVersion),
    index("flow_field_schemas_flow_id_idx").on(t.flowId),
    index("flow_field_schemas_flow_status_idx").on(t.flowId, t.status),
  ],
);

// ── TypeScript types ─────────────────────────────────────────────────────────
export type FlowFieldSchema = typeof flowFieldSchemasTable.$inferSelect;
export type InsertFlowFieldSchema = typeof flowFieldSchemasTable.$inferInsert;
