import { getPool } from '../dbClient';

export interface BatchExecutionRow {
  batch_execution_id: string;
  epic_id: string;
  project_key: string;
  story_ids: string[];
  packet_plan_json: object | null;
  current_state: string;
  failure_reason: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export class BatchExecutionRepository {
  async create(
    batchExecutionId: string,
    epicId: string,
    projectKey: string,
    storyIds: string[],
    startedAt: Date
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO batch_executions (batch_execution_id, epic_id, project_key, story_ids, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [batchExecutionId, epicId, projectKey, storyIds, startedAt]
    );
  }

  async findById(batchExecutionId: string): Promise<BatchExecutionRow | null> {
    const pool = getPool();
    try {
      const result = await pool.query<BatchExecutionRow>(
        `SELECT batch_execution_id, epic_id, project_key, story_ids, packet_plan_json, current_state, failure_reason, started_at, completed_at
         FROM batch_executions
         WHERE batch_execution_id = $1`,
        [batchExecutionId]
      );
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[BatchExecutionRepository.findById] Error fetching batch execution ${batchExecutionId}:`, err.message);
      }
      throw err;
    }
  }

  async updatePacketPlan(
    batchExecutionId: string,
    packetPlan: object
  ): Promise<void> {
    const pool = getPool();
    try {
      await pool.query(
        `UPDATE batch_executions
         SET packet_plan_json = $1
         WHERE batch_execution_id = $2`,
        [JSON.stringify(packetPlan), batchExecutionId]
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[BatchExecutionRepository.updatePacketPlan] Error updating packet plan for batch ${batchExecutionId}:`, err.message);
      }
      throw err;
    }
  }

  async updateState(
    batchExecutionId: string,
    newState: string,
    failureReason?: string
  ): Promise<void> {
    const pool = getPool();
    const completedAt = (newState === 'COMPLETED' || newState === 'FAILED') ? new Date() : null;
    try {
      await pool.query(
        `UPDATE batch_executions
         SET current_state = $1, failure_reason = $2, completed_at = $3
         WHERE batch_execution_id = $4`,
        [newState, failureReason || null, completedAt, batchExecutionId]
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[BatchExecutionRepository.updateState] Error updating state for batch ${batchExecutionId}:`, err.message);
      }
      throw err;
    }
  }

  async checkAllChildrenTerminal(batchExecutionId: string): Promise<{ allTerminal: boolean; anyFailed: boolean }> {
    const pool = getPool();
    try {
      const result = await pool.query<{ all_terminal: boolean; any_failed: boolean }>(
        `SELECT 
           BOOL_AND(current_state IN ('COMPLETED', 'FAILED')) AS all_terminal,
           BOOL_OR(current_state = 'FAILED') AS any_failed
         FROM executions
         WHERE batch_execution_id = $1`,
        [batchExecutionId]
      );
      if (result.rows.length === 0) {
        return { allTerminal: false, anyFailed: false };
      }
      return {
        allTerminal: result.rows[0].all_terminal ?? false,
        anyFailed: result.rows[0].any_failed ?? false
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[BatchExecutionRepository.checkAllChildrenTerminal] Error checking children for batch ${batchExecutionId}:`, err.message);
      }
      throw err;
    }
  }
}
