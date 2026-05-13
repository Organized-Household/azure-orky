-- Migration 007: Create batch_executions table and add batch_execution_id to executions
-- Purpose: Support multi-story batch orchestration lifecycle tracking
-- Story: ORKY-48

CREATE TABLE batch_executions (
  batch_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epic_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  story_ids TEXT[] NOT NULL,
  packet_plan_json JSONB,
  current_state TEXT NOT NULL DEFAULT 'STORIES_RETRIEVING',
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_batch_executions_epic_id ON batch_executions(epic_id);
CREATE INDEX idx_batch_executions_current_state ON batch_executions(current_state);

ALTER TABLE executions ADD COLUMN batch_execution_id UUID REFERENCES batch_executions(batch_execution_id);

CREATE INDEX idx_executions_batch_execution_id ON executions(batch_execution_id);
