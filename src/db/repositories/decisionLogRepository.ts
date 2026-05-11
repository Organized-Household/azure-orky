import { getPool } from '../dbClient';

export interface DecisionLogEntry {
  executionId: string;
  epicId?: string;
  storyId: string;
  filesChanged: string;
  patternsUsed: string;
  migrationApplied?: string;
  summary: string;
}

export interface DecisionLogRow {
  id: number;
  executionId: string;
  epicId: string | null;
  storyId: string;
  filesChanged: string;
  patternsUsed: string;
  migrationApplied: string | null;
  summary: string;
  createdAt: Date;
}

export class DecisionLogRepository {
  async write(entry: DecisionLogEntry): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO decision_logs
         (execution_id, epic_id, story_id, files_changed, patterns_used, migration_applied, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.executionId,
        entry.epicId ?? null,
        entry.storyId,
        entry.filesChanged,
        entry.patternsUsed,
        entry.migrationApplied ?? null,
        entry.summary,
      ],
    );
  }

  async getRecentByEpic(epicId: string, limit: number = 5): Promise<DecisionLogRow[]> {
    const pool = getPool();
    const result = await pool.query<{
      id: number;
      execution_id: string;
      epic_id: string | null;
      story_id: string;
      files_changed: string;
      patterns_used: string;
      migration_applied: string | null;
      summary: string;
      created_at: Date;
    }>(
      `SELECT id, execution_id, epic_id, story_id,
              files_changed, patterns_used, migration_applied, summary, created_at
       FROM decision_logs
       WHERE epic_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [epicId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      executionId: row.execution_id,
      epicId: row.epic_id,
      storyId: row.story_id,
      filesChanged: row.files_changed,
      patternsUsed: row.patterns_used,
      migrationApplied: row.migration_applied,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }
}
