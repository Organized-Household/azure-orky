import { getPool } from '../dbClient';

export type CallType = 'forge_generate' | 'forge_revise' | 'packet_review';

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  estimatedCostUsd: number;
}

// claude-sonnet-4-5 pricing (as of 2026-05)
// Input:  $3.00 per million tokens
// Output: $15.00 per million tokens
const INPUT_COST_PER_MILLION  = 3.00;
const OUTPUT_COST_PER_MILLION = 15.00;

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  const inputCost  = (inputTokens  / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
  return Math.round((inputCost + outputCost) * 10_000) / 10_000; // 4 decimal places
}

export class TokenUsageRepository {
  /**
   * Records token usage for a single-story execution.
   * executionId must exist in the executions table.
   */
  async record(
    executionId: string,
    callType: CallType,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO token_usage (execution_id, call_type, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4)`,
      [executionId, callType, inputTokens, outputTokens],
    );
  }

  /**
   * ORKY-97: Records token usage for a batch execution.
   * batchExecutionId exists in batch_executions, not executions.
   * execution_id is stored as NULL; batch_execution_id is populated.
   */
  async recordBatch(
    batchExecutionId: string,
    callType: CallType,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO token_usage (execution_id, batch_execution_id, call_type, input_tokens, output_tokens)
       VALUES (NULL, $1, $2, $3, $4)`,
      [batchExecutionId, callType, inputTokens, outputTokens],
    );
  }

  async sumByExecution(executionId: string): Promise<TokenUsageSummary> {
    const pool = getPool();
    const result = await pool.query<{
      inputTokens: string;
      outputTokens: string;
      totalTokens: string;
      callCount: string;
    }>(
      `SELECT
         COALESCE(SUM(input_tokens),  0) AS "inputTokens",
         COALESCE(SUM(output_tokens), 0) AS "outputTokens",
         COALESCE(SUM(input_tokens + output_tokens), 0) AS "totalTokens",
         COUNT(*)                         AS "callCount"
       FROM token_usage
       WHERE execution_id = $1`,
      [executionId],
    );

    const row = result.rows[0];
    const inputTokens  = parseInt(row.inputTokens,  10);
    const outputTokens = parseInt(row.outputTokens, 10);
    const totalTokens  = parseInt(row.totalTokens,  10);
    const callCount    = parseInt(row.callCount,     10);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      callCount,
      estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
    };
  }

  async sumByBatchExecution(batchExecutionId: string): Promise<TokenUsageSummary> {
    const pool = getPool();
    const result = await pool.query<{
      inputTokens: string;
      outputTokens: string;
      totalTokens: string;
      callCount: string;
    }>(
      `SELECT
         COALESCE(SUM(input_tokens),  0) AS "inputTokens",
         COALESCE(SUM(output_tokens), 0) AS "outputTokens",
         COALESCE(SUM(input_tokens + output_tokens), 0) AS "totalTokens",
         COUNT(*)                         AS "callCount"
       FROM token_usage
       WHERE batch_execution_id = $1`,
      [batchExecutionId],
    );

    const row = result.rows[0];
    const inputTokens  = parseInt(row.inputTokens,  10);
    const outputTokens = parseInt(row.outputTokens, 10);
    const totalTokens  = parseInt(row.totalTokens,  10);
    const callCount    = parseInt(row.callCount,     10);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      callCount,
      estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
    };
  }
}
