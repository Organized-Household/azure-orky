-- Migration 018: create projects table for multi-project support
-- Stores per-project configuration: target repository, base branch
-- Applied manually via Supabase SQL Editor by Architect
-- Required before ORKY-75+78 PR is merged to dev

CREATE TABLE IF NOT EXISTS projects (
  project_key        VARCHAR(50)  PRIMARY KEY,
  display_name       TEXT         NOT NULL,
  target_repository  TEXT         NOT NULL,
  base_branch        TEXT         NOT NULL DEFAULT 'main',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the ORKY project row
-- This must exist before the application code deploys
INSERT INTO projects (project_key, display_name, target_repository, base_branch)
VALUES ('ORKY', 'Orky', 'orkyai25-ctrl/orky', 'dev')
ON CONFLICT (project_key) DO UPDATE
  SET display_name      = EXCLUDED.display_name,
      target_repository = EXCLUDED.target_repository,
      base_branch       = EXCLUDED.base_branch,
      updated_at        = NOW();

-- Verification query (run after applying):
-- SELECT project_key, target_repository, base_branch FROM projects;
-- Expected: ORKY | orkyai25-ctrl/orky | dev
