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
  // ORKY-96: batch execution path uses batchExecutionId instead of executionId.
  // When provided, executionId is stored as NULL and batchExecutionId is populated.
  batchExecutionId?: string;
}

export class AuditLogRepository {
  async create(input: AuditLogInput): Promise<void> {
    const pool = getPool();
    // ORKY-96: if batchExecutionId is provided, write it to batch_execution_id
    // and store NULL for execution_id (which has a FK to executions).
    const executionIdValue = input.batchExecutionId ? null : (input.executionId || null);
    const batchExecutionIdValue = input.batchExecutionId ?? null;
    await pool.query(
      `INSERT INTO audit_logs (
        audit_log_id, execution_id, batch_execution_id, story_id, step, state, status, message, metadata_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        executionIdValue,
        batchExecutionIdValue,
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
        batch_execution_id AS "batchExecutionId",
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

  async getByBatchExecutionId(batchExecutionId: string): Promise<AuditLogInput[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        execution_id AS "executionId",
        batch_execution_id AS "batchExecutionId",
        story_id AS "storyId",
        step, state, status, message,
        metadata_json AS "metadataJson",
        timestamp
       FROM audit_logs
       WHERE batch_execution_id = $1
       ORDER BY timestamp ASC`,
      [batchExecutionId]
    );
    return result.rows;
  }
}