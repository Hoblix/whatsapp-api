import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Tenants ───────────────────────────────────────────────────────────────────
// Each tenant represents one WhatsApp Business Account managed by this platform.
export const flowTenantsTable = pgTable("flow_tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),           // used in /api/flows/endpoint/:slug/:flowSlug
  wabaId: text("waba_id").notNull(),
  phoneNumberId: text("phone_number_id").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(), // AES-256-GCM encrypted access token
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── RSA Key Pairs per Tenant ──────────────────────────────────────────────────
// WhatsApp Flows uses RSA-2048 key pairs.  The public key is registered with
// Meta; the private key is stored AES-256-GCM encrypted at rest.
// At most one key per tenant should have is_active=true at a time (rotate-key
// deactivates all previous rows first).
export const flowRsaKeysTable = pgTable("flow_rsa_keys", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
  publicKeyPem: text("public_key_pem").notNull(),
  privateKeyEnc: text("private_key_enc").notNull(),  // AES-256-GCM encrypted PEM
  isActive: boolean("is_active").notNull().default(true),
  metaKeyId: text("meta_key_id"),                    // Meta asset ID after successful upload
  metaRegisteredAt: timestamp("meta_registered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flow Definitions ──────────────────────────────────────────────────────────
// Each flow definition maps to a WhatsApp Flow created in Meta Business Manager.
// slug must be unique within a tenant.
export const flowDefinitionsTable = pgTable(
  "flow_definitions",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
    metaFlowId: text("meta_flow_id"),        // Meta's flow ID (optional, for reference)
    name: text("name").notNull(),
    slug: text("slug").notNull(),             // URL-safe; unique per tenant
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("flow_def_tenant_slug_idx").on(t.tenantId, t.slug)],
);

// ── Flow Submissions ──────────────────────────────────────────────────────────
// Written when Meta sends action === "complete" to the flow endpoint.
export const flowSubmissionsTable = pgTable("flow_submissions", {
  id: serial("id").primaryKey(),
  flowId: integer("flow_id")
    .notNull()
    .references(() => flowDefinitionsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
  waPhone: text("wa_phone"),                // submitter's WhatsApp number
  flowToken: text("flow_token"),            // Meta's flow_token for deduplication
  screenResponses: jsonb("screen_responses"), // all collected data as JSONB
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flow Analytics Events ─────────────────────────────────────────────────────
// Every request to the flow endpoint writes an event row for analytics.
export const flowAnalyticsEventsTable = pgTable("flow_analytics_events", {
  id: serial("id").primaryKey(),
  flowId: integer("flow_id")
    .notNull()
    .references(() => flowDefinitionsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // 'init' | 'screen_viewed' | 'completed' | 'error'
  screenName: text("screen_name"),
  waPhone: text("wa_phone"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flow Screens ──────────────────────────────────────────────────────────────
// Each screen represents a logical step in a WhatsApp Flow.
// The screenId must match the screen name used in Meta's Flow JSON exactly.
// At most one screen per flow should have isFirst=true (shown on INIT action).
export const flowScreensTable = pgTable(
  "flow_screens",
  {
    id: serial("id").primaryKey(),
    flowId: integer("flow_id")
      .notNull()
      .references(() => flowDefinitionsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
    screenId: text("screen_id").notNull(),           // Matches screen name in Meta's Flow JSON
    label: text("label"),                             // Human-readable label for the dashboard
    isFirst: boolean("is_first").notNull().default(false), // Entry point screen (used on INIT)
    defaultNextScreen: text("default_next_screen"),   // Fallback if no routing rule matches
    initData: jsonb("init_data"),                     // Pre-populated data injected on INIT
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_screen_flow_screen_id_idx").on(t.flowId, t.screenId),
    // Non-unique index for INIT hot path — look up first screen per flow quickly
    index("flow_screen_flow_is_first_idx").on(t.flowId, t.isFirst),
  ],
);

// ── Flow Routing Rules ────────────────────────────────────────────────────────
// Conditional branching rules attached to a screen, evaluated in priority order
// (lower priority integer = evaluated first).
// If a rule's condition matches, navigation jumps to nextScreen with injectData
// merged into the response. If no rule matches, defaultNextScreen is used.
export const flowRoutingRulesTable = pgTable(
  "flow_routing_rules",
  {
    id: serial("id").primaryKey(),
    screenDbId: integer("screen_db_id")
      .notNull()
      .references(() => flowScreensTable.id, { onDelete: "cascade" }),
    flowId: integer("flow_id")
      .notNull()
      .references(() => flowDefinitionsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),      // Lower = evaluated first
    fieldName: text("field_name").notNull(),                  // Field in decrypted data to test
    operator: text("operator").notNull(),                     // eq | neq | contains | gt | lt | exists
    fieldValue: text("field_value"),                          // Comparison value (null for "exists")
    nextScreen: text("next_screen").notNull(),                // Screen to go to on match
    injectData: jsonb("inject_data"),                         // Extra data merged into response
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Index for navigate hot path — fetch rules by screen ordered by priority
    index("flow_routing_rules_screen_priority_idx").on(t.screenDbId, t.priority),
  ],
);

// ── Flow Integrations ─────────────────────────────────────────────────────────
// Each integration connects a flow to an external destination (e.g. Notion).
// config stores provider-specific credentials (encrypted token, database id …).
export const flowIntegrationsTable = pgTable("flow_integrations", {
  id: serial("id").primaryKey(),
  flowId: integer("flow_id")
    .notNull()
    .references(() => flowDefinitionsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => flowTenantsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // "notion" | more in future
  name: text("name").notNull(),          // user-defined label
  isActive: boolean("is_active").notNull().default(true),
  config: jsonb("config").notNull(),     // { notionToken, databaseId, databaseName }
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flow Integration Field Mappings ───────────────────────────────────────────
// Maps a flow submission field (sourceField) to a destination property (targetField).
// targetFieldType is the Notion property type used to format the value correctly.
export const flowIntegrationMappingsTable = pgTable("flow_integration_mappings", {
  id: serial("id").primaryKey(),
  integrationId: integer("integration_id")
    .notNull()
    .references(() => flowIntegrationsTable.id, { onDelete: "cascade" }),
  sourceField: text("source_field").notNull(),     // key in screenResponses (or "" when isStatic)
  targetField: text("target_field").notNull(),      // Notion property name/id
  targetFieldType: text("target_field_type"),       // title | rich_text | select | number | date | phone_number | email | url | checkbox
  isStatic: boolean("is_static").notNull().default(false), // if true, push staticValue regardless of form data
  staticValue: text("static_value"),               // literal value pushed when isStatic=true
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Flow Active Sessions ──────────────────────────────────────────────────────
// Temporary state storage during flow data_exchange, keyed by flowToken.
// This replaces in-memory Maps so data isn't lost across worker boundary.
export const flowSessionsTable = pgTable("flow_sessions", {
  flowToken: text("flow_token").primaryKey(),
  sessionData: jsonb("session_data").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── TypeScript types ──────────────────────────────────────────────────────────
export type FlowTenant = typeof flowTenantsTable.$inferSelect;
export type InsertFlowTenant = typeof flowTenantsTable.$inferInsert;
export type FlowRsaKey = typeof flowRsaKeysTable.$inferSelect;
export type FlowDefinition = typeof flowDefinitionsTable.$inferSelect;
export type InsertFlowDefinition = typeof flowDefinitionsTable.$inferInsert;
export type FlowSubmission = typeof flowSubmissionsTable.$inferSelect;
export type FlowAnalyticsEvent = typeof flowAnalyticsEventsTable.$inferSelect;
export type FlowScreen = typeof flowScreensTable.$inferSelect;
export type InsertFlowScreen = typeof flowScreensTable.$inferInsert;
export type FlowRoutingRule = typeof flowRoutingRulesTable.$inferSelect;
export type InsertFlowRoutingRule = typeof flowRoutingRulesTable.$inferInsert;
export type FlowIntegration = typeof flowIntegrationsTable.$inferSelect;
export type InsertFlowIntegration = typeof flowIntegrationsTable.$inferInsert;
export type FlowIntegrationMapping = typeof flowIntegrationMappingsTable.$inferSelect;
export type InsertFlowIntegrationMapping = typeof flowIntegrationMappingsTable.$inferInsert;
export type FlowSession = typeof flowSessionsTable.$inferSelect;
export type InsertFlowSession = typeof flowSessionsTable.$inferInsert;
