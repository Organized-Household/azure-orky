-- Migration 019: per-project credential storage
-- Enables per-project Jira and GitHub credential configuration
-- Applied manually via Supabase SQL Editor by Architect
-- Required before ORKY-77 PR is merged to dev

CREATE TABLE IF NOT EXISTS project_credentials (
  project_key      VARCHAR(50)  NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
  credential_type  TEXT         NOT NULL CHECK (credential_type IN (
                     'github_token',
                     'jira_api_token',
                     'jira_base_url',
                     'jira_email',
                     'jira_completion_transition_id',
                     'jira_failure_transition_id'
                   )),
  credential_value TEXT         NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_key, credential_type)
);

-- No seed rows — ORKY project uses env var fallback
-- Add rows via POST /projects/:projectKey/credentials API endpoint

-- Verification query (run after applying):
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'project_credentials';
-- Expected: one row returned
