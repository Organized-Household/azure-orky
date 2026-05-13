import { getPool } from '../dbClient';
import { PacketPlan } from '../../integrations/forge/forgePlannerClient';

export interface BatchExecutionRow {
  batch_execution_id: string;
  epic_id: string;
  project_key: string;
  current_state: string;
  story_ids: string[];
  packet_plan_json: PacketPlan | null;
  started_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
}

export class BatchExecutionRepository {
  async create(
    batchExecutionId: string,
    epicId: string,
    projectKey: string,
    storyIds: string[],
    startedAt: Date,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO batch_executions (
        batch_execution_id, epic_id, project_key, story_ids, current_state, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [batchExecutionId, epicId, projectKey, JSON.stringify(storyIds), 'RECEIVED', startedAt],
    );
    console.log(`[BatchExecutionRepository] Batch ${batchExecutionId} created for epic ${epicId} with ${storyIds.length} stories`);
  }

  async findById(batchExecutionId: string): Promise<BatchExecutionRow | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT batch_execution_id, epic_id, project_key, current_state, story_ids, packet_plan_json, started_at, completed_at, failure_reason
       FROM batch_executions
       WHERE batch_execution_id = $1`,
      [batchExecutionId],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0] as BatchExecutionRow;
  }

  async updatePacketPlan(batchExecutionId: string, packetPlan: PacketPlan): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE batch_executions SET packet_plan_json = $1 WHERE batch_execution_id = $2`,
      [JSON.stringify(packetPlan), batchExecutionId],
    );
    console.log(`[BatchExecutionRepository] Packet plan stored for batch ${batchExecutionId}`);
  }

  async updateState(
    batchExecutionId: string,
    newState: string,
    failureReason?: string,
  ): Promise<void> {
    const pool = getPool();
    const terminalStates = ['PACKET_PLAN_APPROVED', 'FAILED', 'COMPLETED', 'PARTIALLY_FAILED'];
    const completedAt = terminalStates.includes(newState) ? new Date() : null;
    await pool.query(
      `UPDATE batch_executions
       SET current_state = $1, failure_reason = $2, completed_at = $3
       WHERE batch_execution_id = $4`,
      [newState, failureReason ?? null, completedAt, batchExecutionId],
    );
    console.log(`[BatchExecutionRepository] Batch ${batchExecutionId} transitioned to ${newState}`);
  }

  async finalizeIfComplete(batchExecutionId: string): Promise<void> {
    const pool = getPool();

    // Count child executions still in-progress
    const pendingResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM executions
       WHERE batch_execution_id = $1
         AND status NOT IN ('COMPLETED', 'FAILED')`,
      [batchExecutionId],
    );
    const pendingCount = (pendingResult.rows[0]?.cnt as number) ?? 0;
    if (pendingCount > 0) {
      console.log(
        `[BatchExecutionRepository] Batch ${batchExecutionId} has ${pendingCount} in-progress execution(s) — not finalizing yet`,
      );
      return;
    }

    // Count failed child executions
    const failedResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM executions
       WHERE batch_execution_id = $1
         AND status = 'FAILED'`,
      [batchExecutionId],
    );
    const failedCount = (failedResult.rows[0]?.cnt as number) ?? 0;
    const finalState = failedCount > 0 ? 'PARTIALLY_FAILED' : 'COMPLETED';

    await pool.query(
      `UPDATE batch_executions
       SET current_state = $1, completed_at = NOW()
       WHERE batch_execution_id = $2
         AND current_state NOT IN ('COMPLETED', 'PARTIALLY_FAILED', 'FAILED')`,
      [finalState, batchExecutionId],
    );
    console.log(
      `[BatchExecutionRepository] Batch ${batchExecutionId} finalized as ${finalState} (${failedCount} child execution(s) failed)`,
    );
  }
}
