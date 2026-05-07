import { randomUUID } from 'crypto';
import { getPool } from '../dbClient';

export interface AuditLogInput {
  executionId: string;
  storyId: string;
  step: string;
  state: string;
  status: string;
  message?: string;
  metadataJson?: string;
  timestamp?: Date;
}

export class AuditLogRepository {
  async create(input: AuditLogInput): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO audit_logs (
        audit_log_id, execution_id, story_id, step, state, status, message, metadata_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        input.executionId,
        input.storyId,
        input.step,
        input.state,
        input.status,
        input.message ?? null,
        input.metadataJson ?? null,
      ]
    );
  }

  async getByExecutionId(executionId: string): Promise<AuditLogInput[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        execution_id AS "executionId",
        story_id AS "storyId",
        step, state, status, message,
        metadata_json AS "metadataJson",
        timestamp
       FROM audit_logs
       WHERE execution_id = $1
       ORDER BY timestamp ASC`,
      [executionId]
    );
    return result.rows;
  }
}