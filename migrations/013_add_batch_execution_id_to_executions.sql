-- Migration 013: add batch_execution_id FK to executions for EPIC-11 batch child-execution tracking

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS batch_execution_id UUID REFERENCES batch_executions(batch_execution_id);

CREATE INDEX IF NOT EXISTS idx_executions_batch_execution_id
  ON executions(batch_execution_id);
