import { getPool } from '../dbClient';
import { PacketPlan } from '../../integrations/forge/forgePlannerClient';

export interface BatchExecutionRow {
  batch_execution_id: string;
  epic_id: string;
  project_key: string;
  status: string;
  current_state: string;
  story_ids: string[];
  packet_plan_json: PacketPlan | null;
  started_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
}

export class BatchExecutionRepository {
  async findById(batchExecutionId: string): Promise<BatchExecutionRow | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT batch_execution_id, epic_id, project_key, status, current_state, story_ids, packet_plan_json, started_at, completed_at, failure_reason
       FROM batch_executions
       WHERE batch_execution_id = $1`,
      [batchExecutionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0] as BatchExecutionRow;
  }

  async updatePacketPlan(batchExecutionId: string, packetPlan: PacketPlan): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE batch_executions
       SET packet_plan_json = $1
       WHERE batch_execution_id = $2`,
      [JSON.stringify(packetPlan), batchExecutionId]
    );

    console.log(`[BatchExecutionRepository] Packet plan stored for batch ${batchExecutionId}`);
  }

  async updateState(
    batchExecutionId: string,
    newState: string,
    status: string,
    failureReason?: string
  ): Promise<void> {
    const pool = getPool();
    const completedAt = status === 'COMPLETED' || status === 'FAILED' ? new Date() : null;

    await pool.query(
      `UPDATE batch_executions
       SET current_state = $1, status = $2, failure_reason = $3, completed_at = $4
       WHERE batch_execution_id = $5`,
      [newState, status, failureReason || null, completedAt, batchExecutionId]
    );

    console.log(`[BatchExecutionRepository] Batch ${batchExecutionId} transitioned to ${newState}`);
  }
}
