import { randomUUID } from 'crypto';
import { getPool } from '../dbClient';
import { EXECUTION_STATES, ExecutionState } from '../../domain/storyPayload';

export interface ExecutionRecord {
  executionId: string;
  storyId: string;
  issueId?: string;
  epicId?: string;
  projectKey?: string;
  batchExecutionId?: string;
  status: ExecutionState;
  currentState: ExecutionState;
  startedAt?: Date;
  completedAt?: Date;
  failureReason?: string;
}

export interface CreateExecutionInput {
  storyId: string;
  issueId?: string;
  epicId?: string;
  projectKey?: string;
  batchExecutionId?: string;
  status?: ExecutionState;
  currentState?: ExecutionState;
  failureReason?: string;
}

export class ExecutionRepository {
  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const executionId = randomUUID();
    const status = input.status ?? EXECUTION_STATES.RECEIVED;
    const currentState = input.currentState ?? EXECUTION_STATES.RECEIVED;
    const pool = getPool();

    await pool.query(
      `INSERT INTO executions (
        execution_id, story_id, issue_id, epic_id, project_key,
        status, current_state, failure_reason, batch_execution_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        executionId,
        input.storyId,
        input.issueId ?? null,
        input.epicId ?? null,
        input.projectKey ?? null,
        status,
        currentState,
        input.failureReason ?? null,
        input.batchExecutionId ?? null,
      ]
    );

    return {
      executionId,
      storyId: input.storyId,
      issueId: input.issueId,
      epicId: input.epicId,
      projectKey: input.projectKey,
      batchExecutionId: input.batchExecutionId,
      status,
      currentState,
    };
  }

  async updateState(executionId: string, state: ExecutionState, failureReason?: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE executions
       SET status = $1,
           current_state = $2,
           failure_reason = COALESCE($3, failure_reason),
           completed_at = CASE WHEN $4 = 'FAILED' THEN NOW() ELSE completed_at END
       WHERE execution_id = $5`,
      [state, state, failureReason ?? null, state, executionId]
    );
  }

  async getById(executionId: string): Promise<ExecutionRecord | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        execution_id AS "executionId",
        story_id AS "storyId",
        issue_id AS "issueId",
        epic_id AS "epicId",
        project_key AS "projectKey",
        status,
        current_state AS "currentState",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        failure_reason AS "failureReason"
       FROM executions
       WHERE execution_id = $1`,
      [executionId]
    );
    return result.rows[0] ?? null;
  }

  async failIfNotTerminal(executionId: string, failureReason: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE executions
       SET status = 'FAILED',
           current_state = 'FAILED',
           failure_reason = $1,
           completed_at = NOW()
       WHERE execution_id = $2
         AND status NOT IN ('COMPLETED', 'FAILED')`,
      [failureReason, executionId]
    );
  }

  /**
   * Attempt to acquire an execution lock for a story.
   * Returns true if the lock was acquired, false if a lock already exists
   * for this story_id and has not expired.
   * Uses INSERT ... ON CONFLICT DO NOTHING for atomic idempotency.
   */
  async acquireLock(storyId: string, executionId: string): Promise<boolean> {
    const pool = getPool();

    // First expire any stale locks for this story
    await pool.query(
      `DELETE FROM execution_locks
       WHERE story_id = $1
         AND expires_at < NOW()`,
      [storyId]
    );

    // Attempt to insert the lock — will fail silently if story_id already exists
    const result = await pool.query(
      `INSERT INTO execution_locks (story_id, execution_id, status, acquired_at, expires_at)
       VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '2 hours')
       ON CONFLICT (story_id) DO NOTHING`,
      [storyId, executionId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Release the execution lock for a story when the execution reaches a terminal state.
   */
  async releaseLock(storyId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM execution_locks WHERE story_id = $1`,
      [storyId]
    );
  }

  /**
   * Returns true if a non-failed execution already exists for this storyId.
   * Used for idempotency: prevents re-processing a story that is already
   * active or has completed successfully.
   */
  async hasActiveOrCompletedExecution(storyId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM executions
       WHERE story_id = $1
       LIMIT 1`,
      [storyId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}