-- Migration 012: relax round_number CHECK constraint on packet_negotiations
-- Original constraint capped at 3 (matching hardcoded MAX_ROUNDS).
-- NEGOTIATION_MAX_ROUNDS is now env-configurable; cap at 10 to stay safe.

ALTER TABLE packet_negotiations
  DROP CONSTRAINT chk_round_number;

ALTER TABLE packet_negotiations
  ADD CONSTRAINT chk_round_number CHECK (round_number >= 1 AND round_number <= 10);
