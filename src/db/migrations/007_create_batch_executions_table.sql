-- Migration: Create batch_executions table
-- Created: 2026-05-12
-- Story: ORKY-46 — STORY-11.2 — Batch Collector

CREATE TABLE IF NOT EXISTS batch_executions (
  batch_execution_id UUID PRIMARY KEY,
  epic_id TEXT NOT NULL,
  story_ids JSONB NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  collected_at TIMESTAMPTZ,
  packet_plan_json JSONB,
  completed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_batch_executions_epic_id ON batch_executions(epic_id);
CREATE INDEX idx_batch_executions_status ON batch_executions(status);
CREATE INDEX idx_batch_executions_started_at ON batch_executions(started_at DESC);

COMMENT ON TABLE batch_executions IS 'Stores batch execution records for multi-story orchestration grouped by epic';
COMMENT ON COLUMN batch_executions.batch_execution_id IS 'Unique identifier for the batch execution';
COMMENT ON COLUMN batch_executions.epic_id IS 'Epic ID grouping stories in this batch';
COMMENT ON COLUMN batch_executions.story_ids IS 'JSON array of story IDs collected in this batch';
COMMENT ON COLUMN batch_executions.status IS 'Current batch execution status (COLLECTED, PLANNED, IN_PROGRESS, COMPLETED, FAILED)';
COMMENT ON COLUMN batch_executions.started_at IS 'Timestamp when collection window started';
COMMENT ON COLUMN batch_executions.collected_at IS 'Timestamp when collection window closed';
COMMENT ON COLUMN batch_executions.packet_plan_json IS 'Packet Plan received from Forge defining how to group stories into DIPs';
COMMENT ON COLUMN batch_executions.completed_at IS 'Timestamp when batch execution completed';
COMMENT ON COLUMN batch_executions.failure_reason IS 'Human-readable failure reason if status is FAILED';
