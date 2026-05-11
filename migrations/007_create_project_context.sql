-- Migration 007: Create project_context table for PDE artifact storage
-- Run against: Supabase PostgreSQL

CREATE TABLE IF NOT EXISTS project_context (
  id            SERIAL PRIMARY KEY,
  artifact_type VARCHAR(100)  NOT NULL,
  artifact_key  VARCHAR(255)  NOT NULL UNIQUE,
  content       TEXT          NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_context_artifact_type
  ON project_context (artifact_type);

-- Seed: insert PDE artifacts
-- Replace content values with actual artifact text before running
INSERT INTO project_context (artifact_type, artifact_key, content) VALUES
  ('ba_pack',           'orky-ba-pack-v1',           'BA Pack placeholder — replace with actual content'),
  ('engineering_spec',  'orky-engineering-spec-v1',  'Engineering Spec placeholder — replace with actual content'),
  ('system_arch',       'orky-system-arch-v1',       'System Architecture placeholder — replace with actual content')
ON CONFLICT (artifact_key) DO NOTHING;
