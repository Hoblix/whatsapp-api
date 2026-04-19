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
import type { DecisionEntry } from "../decisionLogger";

// ── Automation Workflows ─────────────────────────────────────────────────────
// Top-level workflow definitions with trigger configuration.

export const automationWorkflowsTable = pgTable(
  "automation_workflows",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    triggerType: text("trigger_type").notNull(), // 'ad_click' | 'website' | 'direct_wa' | 'manual'
    triggerConfig: jsonb("trigger_config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(false),
    debugMode: boolean("debug_mode").notNull().default(false),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automation_workflows_active_trigger_idx").on(t.isActive, t.triggerType),
  ],
);

// ── Automation Nodes ─────────────────────────────────────────────────────────
// Tree of nodes within a workflow (trigger → actions → branches → conditions).

export const automationNodesTable = pgTable(
  "automation_nodes",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id")
      .notNull()
      .references(() => automationWorkflowsTable.id, { onDelete: "cascade" }),
    parentNodeId: integer("parent_node_id"), // null for root trigger node
    nodeType: text("node_type").notNull(), // 'trigger' | 'action' | 'branch' | 'condition'
    position: integer("position").notNull().default(0),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automation_nodes_workflow_idx").on(t.workflowId),
    index("automation_nodes_parent_position_idx").on(t.parentNodeId, t.position),
  ],
);

// ── Automation Executions ────────────────────────────────────────────────────
// Runtime state for a workflow execution tied to a phone number / conversation.

export const automationExecutionsTable = pgTable(
  "automation_executions",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id")
      .notNull()
      .references(() => automationWorkflowsTable.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    conversationId: integer("conversation_id"),
    status: text("status").notNull().default("running"), // 'running' | 'waiting' | 'completed' | 'failed'
    currentNodeId: integer("current_node_id"),
    context: jsonb("context").notNull().default({}),
    resumeAt: timestamp("resume_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("automation_executions_phone_workflow_idx").on(t.phoneNumber, t.workflowId),
    index("automation_executions_workflow_started_idx").on(t.workflowId, t.startedAt),
  ],
);

// ── Automation Condition Logs ────────────────────────────────────────────────
// Per-condition decision records from v2 branch evaluations.

export const automationConditionLogsTable = pgTable(
  "automation_condition_logs",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id")
      .notNull()
      .references(() => automationWorkflowsTable.id, { onDelete: "cascade" }),
    executionId: integer("execution_id")
      .notNull()
      .references(() => automationExecutionsTable.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    schemaVersion: text("schema_version"),
    logic: text("logic"), // "and" | "or"
    durationMs: integer("duration_ms"),
    decisions: jsonb("decisions").notNull().$type<DecisionEntry[]>(),
    finalResult: text("final_result").notNull(), // "TRUE" | "FALSE" | "FAILED"
    failedReason: text("failed_reason"),
    branchTaken: text("branch_taken"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automation_condition_logs_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("automation_condition_logs_execution_idx").on(t.executionId),
  ],
);

// ── TypeScript types ─────────────────────────────────────────────────────────
export type AutomationWorkflow = typeof automationWorkflowsTable.$inferSelect;
export type InsertAutomationWorkflow = typeof automationWorkflowsTable.$inferInsert;
export type AutomationNode = typeof automationNodesTable.$inferSelect;
export type InsertAutomationNode = typeof automationNodesTable.$inferInsert;
export type AutomationExecution = typeof automationExecutionsTable.$inferSelect;
export type InsertAutomationExecution = typeof automationExecutionsTable.$inferInsert;
export type AutomationConditionLog = typeof automationConditionLogsTable.$inferSelect;
export type InsertAutomationConditionLog = typeof automationConditionLogsTable.$inferInsert;
