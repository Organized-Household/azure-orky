import { getPool } from '../dbClient';
import { BatchExecution, NewBatchExecution } from '../models/BatchExecution';

import { randomUUID } from 'crypto';

export class BatchExecutionRepository {
  async create(data: NewBatchExecution): Promise<BatchExecution> {
    const pool = getPool();
    const batchExecutionId = randomUUID();

    const query = `
      INSERT INTO batch_executions (
        batch_execution_id,
        epic_id,
        project_key,
        batch_status,
        story_ids,
        packet_plan_json
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      batchExecutionId,
      data.epic_id,
      data.project_key,
      data.batch_status,
      JSON.stringify(data.story_ids),
      data.packet_plan_json ? JSON.stringify(data.packet_plan_json) : null
    ];

    try {
      const result = await pool.query(query, values);
      const row = result.rows[0];

      console.log('BatchExecution created', {
        batchExecutionId,
        epicId: data.epic_id,
        storyCount: data.story_ids.length
      });

      return this.mapRowToBatchExecution(row);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Failed to create BatchExecution', {
          error: err.message,
          epicId: data.epic_id
        });
        throw new Error(`Failed to create BatchExecution: ${err.message}`);
      }
      throw new Error('Failed to create BatchExecution: unknown error');
    }
  }

  async updatePacketPlan(
    batchExecutionId: string,
    packetPlanJson: object
  ): Promise<void> {
    const pool = getPool();

    const query = `
      UPDATE batch_executions
      SET packet_plan_json = $1, updated_at = NOW()
      WHERE batch_execution_id = $2
    `;

    const values = [JSON.stringify(packetPlanJson), batchExecutionId];

    try {
      await pool.query(query, values);

      console.log('BatchExecution packet_plan_json updated', {
        batchExecutionId
      });
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Failed to update packet_plan_json', {
          error: err.message,
          batchExecutionId
        });
        throw new Error(`Failed to update packet_plan_json: ${err.message}`);
      }
      throw new Error('Failed to update packet_plan_json: unknown error');
    }
  }

  async updateStatus(
    batchExecutionId: string,
    status: string,
    failureReason?: string
  ): Promise<void> {
    const pool = getPool();

    const query = `
      UPDATE batch_executions
      SET batch_status = $1,
          failure_reason = $2,
          updated_at = NOW(),
          completed_at = CASE WHEN $1 IN ('COMPLETED', 'FAILED') THEN NOW() ELSE completed_at END
      WHERE batch_execution_id = $3
    `;

    const values = [status, failureReason || null, batchExecutionId];

    try {
      await pool.query(query, values);

      console.log('BatchExecution status updated', {
        batchExecutionId,
        status,
        failureReason
      });
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Failed to update BatchExecution status', {
          error: err.message,
          batchExecutionId
        });
        throw new Error(`Failed to update BatchExecution status: ${err.message}`);
      }
      throw new Error('Failed to update BatchExecution status: unknown error');
    }
  }

  async findById(batchExecutionId: string): Promise<BatchExecution | null> {
    const pool = getPool();

    const query = `
      SELECT * FROM batch_executions
      WHERE batch_execution_id = $1
    `;

    const values = [batchExecutionId];

    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToBatchExecution(result.rows[0]);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Failed to find BatchExecution by ID', {
          error: err.message,
          batchExecutionId
        });
        throw new Error(`Failed to find BatchExecution: ${err.message}`);
      }
      throw new Error('Failed to find BatchExecution: unknown error');
    }
  }

  private mapRowToBatchExecution(row: any): BatchExecution {
    return {
      batch_execution_id: row.batch_execution_id,
      epic_id: row.epic_id,
      project_key: row.project_key,
      batch_status: row.batch_status,
      story_ids: Array.isArray(row.story_ids)
        ? row.story_ids
        : JSON.parse(row.story_ids),
      packet_plan_json: row.packet_plan_json
        ? typeof row.packet_plan_json === 'string'
          ? JSON.parse(row.packet_plan_json)
          : row.packet_plan_json
        : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      failure_reason: row.failure_reason
    };
  }
}
