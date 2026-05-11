-- Migration 008: Create decision_logs table for implementation history
-- Run against: Supabase PostgreSQL

CREATE TABLE IF NOT EXISTS decision_logs (
  id                SERIAL PRIMARY KEY,
  execution_id      UUID          NOT NULL REFERENCES executions(execution_id),
  epic_id           VARCHAR(100),
  story_id          VARCHAR(100)  NOT NULL,
  files_changed     TEXT          NOT NULL,
  patterns_used     TEXT          NOT NULL,
  migration_applied TEXT,
  summary           TEXT          NOT NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_epic_id
  ON decision_logs (epic_id);

CREATE INDEX IF NOT EXISTS idx_decision_logs_execution_id
  ON decision_logs (execution_id);

CREATE INDEX IF NOT EXISTS idx_decision_logs_created_at
  ON decision_logs (created_at DESC);
