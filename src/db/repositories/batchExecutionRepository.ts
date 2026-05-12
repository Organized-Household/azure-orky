import { getPool } from '../dbClient';

export interface BatchExecutionRecord {
  batchExecutionId: string;
  epicId: string;
  storyIds: string[];
  status: string;
  startedAt: Date;
  collectedAt?: Date;
  packetPlanJson?: string;
  completedAt?: Date;
  failureReason?: string;
}

export class BatchExecutionRepository {
  async create(record: BatchExecutionRecord): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO batch_executions (
        batch_execution_id,
        epic_id,
        story_ids,
        status,
        started_at,
        collected_at,
        packet_plan_json,
        completed_at,
        failure_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.batchExecutionId,
        record.epicId,
        JSON.stringify(record.storyIds),
        record.status,
        record.startedAt,
        record.collectedAt || null,
        record.packetPlanJson || null,
        record.completedAt || null,
        record.failureReason || null
      ]
    );
  }

  async updateStatus(
    batchExecutionId: string,
    status: string,
    failureReason?: string
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE batch_executions
       SET status = $1, failure_reason = $2
       WHERE batch_execution_id = $3`,
      [status, failureReason || null, batchExecutionId]
    );
  }

  async updatePacketPlan(
    batchExecutionId: string,
    packetPlanJson: string
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE batch_executions
       SET packet_plan_json = $1
       WHERE batch_execution_id = $2`,
      [packetPlanJson, batchExecutionId]
    );
  }

  async complete(
    batchExecutionId: string,
    status: string
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE batch_executions
       SET status = $1, completed_at = NOW()
       WHERE batch_execution_id = $2`,
      [status, batchExecutionId]
    );
  }

  async getById(batchExecutionId: string): Promise<BatchExecutionRecord | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        batch_execution_id,
        epic_id,
        story_ids,
        status,
        started_at,
        collected_at,
        packet_plan_json,
        completed_at,
        failure_reason
       FROM batch_executions
       WHERE batch_execution_id = $1`,
      [batchExecutionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      batchExecutionId: row.batch_execution_id,
      epicId: row.epic_id,
      storyIds: JSON.parse(row.story_ids),
      status: row.status,
      startedAt: row.started_at,
      collectedAt: row.collected_at,
      packetPlanJson: row.packet_plan_json,
      completedAt: row.completed_at,
      failureReason: row.failure_reason
    };
  }

  async getByEpicId(epicId: string): Promise<BatchExecutionRecord[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        batch_execution_id,
        epic_id,
        story_ids,
        status,
        started_at,
        collected_at,
        packet_plan_json,
        completed_at,
        failure_reason
       FROM batch_executions
       WHERE epic_id = $1
       ORDER BY started_at DESC`,
      [epicId]
    );

    return result.rows.map((row) => ({
      batchExecutionId: row.batch_execution_id,
      epicId: row.epic_id,
      storyIds: JSON.parse(row.story_ids),
      status: row.status,
      startedAt: row.started_at,
      collectedAt: row.collected_at,
      packetPlanJson: row.packet_plan_json,
      completedAt: row.completed_at,
      failureReason: row.failure_reason
    }));
  }
}
