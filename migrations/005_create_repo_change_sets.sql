-- migrations/005_create_repo_change_sets.sql
-- Sprint 5: Create repo_change_sets table
-- PostgreSQL syntax (Supabase). Run manually in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS repo_change_sets (
  change_set_id   TEXT        NOT NULL PRIMARY KEY,
  execution_id    UUID        NOT NULL REFERENCES executions(execution_id),
  story_id        TEXT        NOT NULL,
  workspace_path  TEXT,
  changed_files   TEXT,           -- JSON array string
  diff_summary    TEXT,
  branch_name     TEXT,
  commit_sha      TEXT,
  pr_url          TEXT,
  head_sha        TEXT,
  merge_sha       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_change_sets_execution_id
  ON repo_change_sets(execution_id);

CREATE INDEX IF NOT EXISTS idx_repo_change_sets_story_id
  ON repo_change_sets(story_id);
