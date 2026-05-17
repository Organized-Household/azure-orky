-- Migration 015: Negotiation Health View
-- ORKY-65 / STORY-14.3 / EPIC-14
--
-- Creates a read-only observability view over packet_negotiations.
-- Computes per-execution: total rounds consumed, stall detection,
-- final verdict, first/last round timestamps, and time-to-resolution.
--
-- No tables created. No columns added. No constraints modified.
-- Safe to re-run: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW negotiation_health_v AS
WITH ordered_rounds AS (
  SELECT
    execution_id,
    round_number,
    verdict,
    issues,
    created_at,
    LAG(issues) OVER (
      PARTITION BY execution_id
      ORDER BY round_number
    ) AS prev_issues
  FROM packet_negotiations
),
stall_flags AS (
  SELECT
    execution_id,
    COUNT(*) FILTER (
      WHERE issues IS NOT NULL
        AND prev_issues IS NOT NULL
        AND issues = prev_issues
    ) AS stall_count
  FROM ordered_rounds
  GROUP BY execution_id
),
round_bounds AS (
  SELECT
    execution_id,
    COUNT(*)                                                          AS total_rounds,
    MIN(created_at)                                                   AS first_round_at,
    MAX(created_at)                                                   AS last_round_at,
    EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) * 1000   AS resolution_ms
  FROM packet_negotiations
  GROUP BY execution_id
),
final_verdicts AS (
  SELECT DISTINCT ON (execution_id)
    execution_id,
    verdict AS final_verdict
  FROM packet_negotiations
  ORDER BY execution_id, round_number DESC
)
SELECT
  rb.execution_id,
  rb.total_rounds,
  fv.final_verdict,
  (sf.stall_count > 0)          AS stalled,
  sf.stall_count,
  rb.first_round_at,
  rb.last_round_at,
  rb.resolution_ms::BIGINT      AS resolution_ms
FROM round_bounds    rb
JOIN stall_flags     sf ON sf.execution_id  = rb.execution_id
JOIN final_verdicts  fv ON fv.execution_id  = rb.execution_id;
