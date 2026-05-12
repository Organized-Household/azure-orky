-- Migration 011: batch_executions table for EPIC-11 multi-story batch execution

CREATE TABLE IF NOT EXISTS batch_executions (
  batch_execution_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  epic_id             TEXT        NOT NULL,
  project_key         TEXT        NOT NULL,
  story_ids           JSONB       NOT NULL DEFAULT '[]',
  current_state       TEXT        NOT NULL DEFAULT 'RECEIVED',
  packet_plan_json    JSONB,
  failure_reason      TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT pk_batch_executions PRIMARY KEY (batch_execution_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_executions_epic_id
  ON batch_executions (epic_id);

CREATE INDEX IF NOT EXISTS idx_batch_executions_current_state
  ON batch_executions (current_state);
