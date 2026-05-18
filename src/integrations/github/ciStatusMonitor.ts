import { Octokit } from '@octokit/rest';
import { CIPoller, CIPollerResult } from './ciPoller';
import { AuditLogger } from '../../audit/auditLogger';

export class CIStatusMonitor {
  private readonly ciPoller: CIPoller;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly auditLogger: AuditLogger
  ) {
    this.ciPoller = new CIPoller(octokit, owner, repo, auditLogger);
  }

  async waitForChecks(
    executionId: string,
    storyId: string,
    prNumber: number,
    headSha: string,
    requiredChecks: string[],
    pollIntervalMs: number = 30000,
    timeoutMs: number = 2700000
  ): Promise<{ success: boolean; checks: CIPollerResult['checks'] }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await this.ciPoller.pollChecks(
        executionId,
        storyId,
        prNumber,
        headSha,
        requiredChecks
      );

      if (result.failed) {
        const failedChecks = result.checks.filter(
          (r: { conclusion: string | null }) =>
            r.conclusion === 'failure' ||
            r.conclusion === 'cancelled' ||
            r.conclusion === 'timed_out' ||
            r.conclusion === 'action_required'
        );

        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'CI_MONITOR',
          state: 'CI_PENDING',
          status: 'failed',
          message: `CI checks failed for PR #${prNumber}`,
          metadata: { prNumber, headSha, failedChecks }
        });

        return { success: false, checks: result.checks };
      }

      if (result.allPassed) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'CI_MONITOR',
          state: 'CI_PASSED',
          status: 'success',
          message: `All CI checks passed for PR #${prNumber}`,
          metadata: { prNumber, headSha, checks: result.checks }
        });

        return { success: true, checks: result.checks };
      }

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_MONITOR',
        state: 'CI_PENDING',
        status: 'in_progress',
        message: `CI checks still pending for PR #${prNumber}, waiting ${pollIntervalMs}ms`,
        metadata: { prNumber, headSha, elapsedMs: Date.now() - startTime }
      });

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'CI_MONITOR',
      state: 'CI_PENDING',
      status: 'timeout',
      message: `CI monitoring timed out after ${timeoutMs}ms for PR #${prNumber}`,
      metadata: { prNumber, headSha, timeoutMs }
    });

    throw new Error(
      `CI monitoring timeout: checks did not complete within ${timeoutMs}ms`
    );
  }
}
