-- Migration 009: Add extended DIP fields to instruction_packets (STORY-9.4)
-- Run against: Supabase PostgreSQL
-- NOTE: Already executed in Supabase on 2026-05-11

ALTER TABLE instruction_packets
  ADD COLUMN IF NOT EXISTS pr_title               TEXT,
  ADD COLUMN IF NOT EXISTS pr_body                TEXT,
  ADD COLUMN IF NOT EXISTS commit_message         TEXT,
  ADD COLUMN IF NOT EXISTS implementation_summary TEXT,
  ADD COLUMN IF NOT EXISTS jira_linkage           TEXT;
