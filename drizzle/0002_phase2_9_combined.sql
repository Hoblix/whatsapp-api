-- ============================================================================
-- Combined Migration: Phases 2, 6, 9
-- Automation Builder Phase 2: Intelligent Branching
-- Run against Supabase PostgreSQL
-- ============================================================================

-- Phase 2: flow_field_schemas table
CREATE TABLE IF NOT EXISTS flow_field_schemas (
  id            SERIAL        PRIMARY KEY,
  flow_id       TEXT          NOT NULL,
  flow_version  TEXT          NOT NULL,
  synced_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status        TEXT          NOT NULL DEFAULT 'active',
  fields        JSONB         NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS flow_field_schemas_flow_version_idx
  ON flow_field_schemas (flow_id, flow_version);
CREATE INDEX IF NOT EXISTS flow_field_schemas_flow_id_idx
  ON flow_field_schemas (flow_id);
CREATE INDEX IF NOT EXISTS flow_field_schemas_flow_status_idx
  ON flow_field_schemas (flow_id, status);

-- Phase 6: Kill switch columns + index
ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS disabled_reason TEXT DEFAULT NULL;
ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS debug_mode BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS automation_executions_workflow_started_idx
  ON automation_executions (workflow_id, started_at);

-- Phase 9: Condition logs table
CREATE TABLE IF NOT EXISTS automation_condition_logs (
  id              SERIAL        PRIMARY KEY,
  workflow_id     INTEGER       NOT NULL REFERENCES automation_workflows(id) ON DELETE CASCADE,
  execution_id    INTEGER       NOT NULL REFERENCES automation_executions(id) ON DELETE CASCADE,
  node_id         TEXT,
  schema_version  TEXT,
  logic           TEXT,
  duration_ms     INTEGER,
  decisions       JSONB         NOT NULL,
  final_result    TEXT          NOT NULL,
  failed_reason   TEXT,
  branch_taken    TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS automation_condition_logs_workflow_created_idx
  ON automation_condition_logs (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS automation_condition_logs_execution_idx
  ON automation_condition_logs (execution_id);
