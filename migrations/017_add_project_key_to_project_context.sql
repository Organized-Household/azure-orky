-- Migration 017: add project_key column to project_context
-- Enables per-project artifact scoping for multi-project support (EPIC-16)
-- Applied manually via Supabase SQL Editor by Architect
-- Required before ORKY-74 (ProjectContextRepository.getByProjectKey) is deployed

-- Step 1: Add column with DEFAULT so existing rows are backfilled immediately
-- DEFAULT 'ORKY' protects in-flight inserts that occur before application code
-- is updated in STORY-16.2
ALTER TABLE project_context
  ADD COLUMN IF NOT EXISTS project_key VARCHAR(50) NOT NULL DEFAULT 'ORKY';

-- Step 2: Explicitly backfill any rows that may have been inserted before
-- the DEFAULT took effect (belt-and-suspenders)
UPDATE project_context
  SET project_key = 'ORKY'
  WHERE project_key IS NULL OR project_key = '';

-- Step 3: Add index for efficient per-project filtering
CREATE INDEX IF NOT EXISTS idx_project_context_project_key
  ON project_context(project_key);

-- Verification query (run after applying):
-- SELECT project_key, COUNT(*) FROM project_context GROUP BY project_key;
-- Expected: one row — project_key='ORKY', count=8
