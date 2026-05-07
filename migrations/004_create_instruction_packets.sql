CREATE TABLE IF NOT EXISTS instruction_packets (
  packet_id           TEXT                NOT NULL PRIMARY KEY,
  execution_id        UUID                NOT NULL REFERENCES executions(execution_id),
  story_id            TEXT                NOT NULL,
  target_repository   TEXT                NOT NULL,
  base_branch         TEXT                NOT NULL,
  branch_name_hint    TEXT                NOT NULL,
  file_operations     TEXT                NOT NULL,  -- JSON
  validation_commands TEXT                NOT NULL,  -- JSON
  received_at         TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
