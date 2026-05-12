-- Migration: Create batch_executions table
-- Story: ORKY-45 (STORY-11.1 — Forge-Driven Packet Planning)
-- Description: Stores batch execution metadata and Forge-generated Packet Plans

CREATE TABLE IF NOT EXISTS batch_executions (
  batch_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epic_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  batch_status TEXT NOT NULL,
  story_ids JSONB NOT NULL,
  packet_plan_json JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  failure_reason TEXT
);

CREATE INDEX idx_batch_executions_epic_id ON batch_executions(epic_id);
CREATE INDEX idx_batch_executions_batch_status ON batch_executions(batch_status);
CREATE INDEX idx_batch_executions_created_at ON batch_executions(created_at DESC);

COMMENT ON TABLE batch_executions IS 'Stores batch execution metadata and Forge-generated Packet Plans for multi-story DIP orchestration';
COMMENT ON COLUMN batch_executions.packet_plan_json IS 'Forge-generated Packet Plan: array of {dipId, storyIds[], rationale}';
COMMENT ON COLUMN batch_executions.story_ids IS 'Array of Jira story IDs included in this batch';
