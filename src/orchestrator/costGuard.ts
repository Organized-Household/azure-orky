import { AuditLogger } from '../audit/auditLogger';
import { TokenUsageRepository } from '../db/repositories/tokenUsageRepository';

export class CostGuardExceededError extends Error {
  constructor(
    public readonly configured: number,
    public readonly used: number,
  ) {
    super(
      `Execution halted by cost guard - token usage exceeded MAX_TOKENS_PER_EXECUTION (configured: ${configured}, used: ${used})`,
    );
    this.name = 'CostGuardExceededError';
  }
}

export class CostGuard {
  private readonly tokenUsageRepo: TokenUsageRepository;
  private readonly auditLogger: AuditLogger;

  constructor(tokenUsageRepo: TokenUsageRepository, auditLogger: AuditLogger) {
    this.tokenUsageRepo = tokenUsageRepo;
    this.auditLogger = auditLogger;
  }

  /**
   * Check the running token total for this execution against MAX_TOKENS_PER_EXECUTION.
   * Logs a cost_guard_check audit entry on every invocation (pass or fail).
   * Throws CostGuardExceededError if the limit is exceeded.
   * Does nothing if MAX_TOKENS_PER_EXECUTION is 0 or unset.
   */
  async check(executionId: string, storyId: string): Promise<void> {
    // Read limit at call time — never at module load or constructor time
    const limitEnv = parseInt(process.env.MAX_TOKENS_PER_EXECUTION ?? '100000', 10);

    // 0 means disabled — return immediately with no audit log
    if (limitEnv === 0) {
      return;
    }

    const summary = await this.tokenUsageRepo.sumByExecution(executionId);
    const used = summary.totalTokens;
    const exceeded = used > limitEnv;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'cost_guard_check',
      state: exceeded ? 'failed' : 'agent_executing',
      status: exceeded ? 'failed' : 'info',
      message: exceeded
        ? `Cost guard exceeded — used ${used} tokens, limit is ${limitEnv}`
        : `Cost guard passed — used ${used} of ${limitEnv} tokens`,
      metadata: {
        configured: limitEnv,
        used,
        exceeded,
      },
    });

    if (exceeded) {
      throw new CostGuardExceededError(limitEnv, used);
    }
  }
}
