-- Migration 020: Add batch_execution_id to audit_logs and token_usage
-- Fixes ORKY-96 and ORKY-97: batch execution path was passing batchExecutionId
-- into execution_id FK columns that reference the executions table, causing
-- FK violations. Both columns are made nullable and a batch_execution_id
-- column is added to each table to correctly identify batch-path records.

-- audit_logs: make execution_id nullable, add batch_execution_id
ALTER TABLE audit_logs
  ALTER COLUMN execution_id DROP NOT NULL;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS batch_execution_id UUID;

-- token_usage: make execution_id nullable, add batch_execution_id
ALTER TABLE token_usage
  ALTER COLUMN execution_id DROP NOT NULL;

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS batch_execution_id UUID;

-- Indexes for batch lookups
CREATE INDEX IF NOT EXISTS idx_audit_logs_batch_execution_id
  ON audit_logs (batch_execution_id)
  WHERE batch_execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_token_usage_batch_execution_id
  ON token_usage (batch_execution_id)
  WHERE batch_execution_id IS NOT NULL;
