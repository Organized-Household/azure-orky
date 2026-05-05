import { randomUUID } from "crypto";
import sql from "mssql";
import { getDbPool } from "../dbClient";
import { EXECUTION_STATES, ExecutionState } from "../../domain/storyPayload";

export interface ExecutionRecord {
  executionId: string;
  storyId: string;
  issueId?: string;
  epicId?: string;
  projectKey?: string;
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
  status?: ExecutionState;
  currentState?: ExecutionState;
  failureReason?: string;
}

export class ExecutionRepository {
  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const executionId = randomUUID();
    const status = input.status ?? EXECUTION_STATES.RECEIVED;
    const currentState = input.currentState ?? EXECUTION_STATES.RECEIVED;
    const pool = await getDbPool();

    await pool
      .request()
      .input("executionId", sql.UniqueIdentifier, executionId)
      .input("storyId", sql.VarChar(255), input.storyId)
      .input("issueId", sql.VarChar(255), input.issueId ?? null)
      .input("epicId", sql.VarChar(255), input.epicId ?? null)
      .input("projectKey", sql.VarChar(50), input.projectKey ?? null)
      .input("status", sql.VarChar(50), status)
      .input("currentState", sql.VarChar(50), currentState)
      .input("failureReason", sql.NVarChar(sql.MAX), input.failureReason ?? null)
      .query(`
        INSERT INTO executions (
          execution_id,
          story_id,
          issue_id,
          epic_id,
          project_key,
          status,
          current_state,
          failure_reason
        )
        VALUES (
          @executionId,
          @storyId,
          @issueId,
          @epicId,
          @projectKey,
          @status,
          @currentState,
          @failureReason
        )
      `);

    return {
      executionId,
      storyId: input.storyId,
      issueId: input.issueId,
      epicId: input.epicId,
      projectKey: input.projectKey,
      status,
      currentState,
    };
  }

  async updateState(
    executionId: string,
    state: ExecutionState,
    failureReason?: string,
  ): Promise<void> {
    const pool = await getDbPool();

    await pool
      .request()
      .input("executionId", sql.UniqueIdentifier, executionId)
      .input("status", sql.VarChar(50), state)
      .input("currentState", sql.VarChar(50), state)
      .input("failureReason", sql.NVarChar(sql.MAX), failureReason ?? null)
      .query(`
        UPDATE executions
        SET
          status = @status,
          current_state = @currentState,
          failure_reason = COALESCE(@failureReason, failure_reason),
          completed_at = CASE WHEN @status = 'FAILED' THEN GETUTCDATE() ELSE completed_at END
        WHERE execution_id = @executionId
      `);
  }


  async getById(executionId: string): Promise<ExecutionRecord | null> {
    const pool = await getDbPool();

    const result = await pool
      .request()
      .input("executionId", sql.UniqueIdentifier, executionId)
      .query(`
        SELECT
          execution_id AS executionId,
          story_id AS storyId,
          issue_id AS issueId,
          epic_id AS epicId,
          project_key AS projectKey,
          status,
          current_state AS currentState,
          started_at AS startedAt,
          completed_at AS completedAt,
          failure_reason AS failureReason
        FROM executions
        WHERE execution_id = @executionId
      `);

    return result.recordset[0] ?? null;
  }

  async failIfNotTerminal(
    executionId: string,
    failureReason: string,
  ): Promise<void> {
    const pool = await getDbPool();

    await pool
      .request()
      .input("executionId", sql.UniqueIdentifier, executionId)
      .input("failureReason", sql.NVarChar(sql.MAX), failureReason)
      .query(`
        UPDATE executions
        SET
          status = 'FAILED',
          current_state = 'FAILED',
          failure_reason = @failureReason,
          completed_at = GETUTCDATE()
        WHERE execution_id = @executionId
          AND status NOT IN ('COMPLETED', 'FAILED')
      `);
  }

}



