-- Migration 010: packet_negotiations table for EPIC-10 negotiation loop
-- FK references executions(execution_id) — not executions(id)

CREATE TABLE IF NOT EXISTS packet_negotiations (
  negotiation_id    TEXT        NOT NULL,
  execution_id      UUID        NOT NULL REFERENCES executions(execution_id),
  story_id          TEXT        NOT NULL,
  round_number      INTEGER     NOT NULL,
  verdict           VARCHAR(20) NOT NULL,
  issues            TEXT        NOT NULL, -- JSON array string
  revised_packet_id TEXT,                 -- NULL on first round; set when Forge revises
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_packet_negotiations PRIMARY KEY (negotiation_id),
  CONSTRAINT chk_verdict CHECK (verdict IN ('APPROVED', 'QUESTIONS')),
  CONSTRAINT chk_round_number CHECK (round_number >= 1 AND round_number <= 3),
  CONSTRAINT uq_execution_round UNIQUE (execution_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_packet_negotiations_execution_id
  ON packet_negotiations (execution_id);

CREATE INDEX IF NOT EXISTS idx_packet_negotiations_story_id
  ON packet_negotiations (story_id);
