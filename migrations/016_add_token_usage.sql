-- Migration 016: per-execution Anthropic API token usage tracking
-- Applied manually via Supabase SQL Editor by Architect
-- Required before ORKY-68 PR is merged to dev

CREATE TABLE IF NOT EXISTS token_usage (
  id            BIGSERIAL PRIMARY KEY,
  execution_id  UUID          NOT NULL REFERENCES executions(execution_id),
  call_type     VARCHAR(50)   NOT NULL CHECK (call_type IN ('forge_generate', 'forge_revise', 'packet_review')),
  input_tokens  INTEGER       NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER       NOT NULL CHECK (output_tokens >= 0),
  called_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_execution_id ON token_usage(execution_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_called_at    ON token_usage(called_at);
