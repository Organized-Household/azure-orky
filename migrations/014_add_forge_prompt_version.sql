-- Migration 014: add forge_prompt_version to instruction_packets for EPIC-13 prompt versioning
-- Additive only — existing rows get NULL, no data lost, no CHECK constraint (informational)

ALTER TABLE instruction_packets
  ADD COLUMN IF NOT EXISTS forge_prompt_version VARCHAR(20);
