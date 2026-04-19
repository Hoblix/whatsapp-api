-- Kill Switch: add disabled_reason column and execution lookup index
ALTER TABLE automation_workflows ADD COLUMN disabled_reason TEXT DEFAULT NULL;
CREATE INDEX automation_executions_workflow_started_idx ON automation_executions (workflow_id, started_at);
