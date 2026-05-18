import { Octokit } from '@octokit/rest';
import { getPool } from '../../db/dbClient';
import { AuditLogger } from '../../audit/auditLogger';

export interface CICheck {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
}

export interface CIPollerResult {
  allPassed: boolean;
  checks: CICheck[];
  pending: boolean;
  failed: boolean;
}

export class CIPoller {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly auditLogger: AuditLogger
  ) {}

  async pollChecks(
    executionId: string,
    storyId: string,
    prNumber: number,
    headSha: string,
    requiredChecks: string[]
  ): Promise<CIPollerResult> {
    try {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_POLL',
        state: 'CI_PENDING',
        status: 'in_progress',
        message: `Polling CI checks for PR #${prNumber}, head SHA ${headSha}`,
        metadata: { prNumber, headSha, requiredChecks }
      });

      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: headSha,
        per_page: 100
      });

      const checks: CICheck[] = checkRuns.check_runs.map(
        (run: { name: string; status: string; conclusion: string | null; completed_at: string | null }) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          completedAt: run.completed_at
        })
      );

      const relevantChecks = checks.filter((check) =>
        requiredChecks.some((req) => check.name.includes(req))
      );

      if (relevantChecks.length === 0) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'CI_POLL',
          state: 'CI_PENDING',
          status: 'warning',
          message: `No matching required checks found for PR #${prNumber}`,
          metadata: { prNumber, headSha, requiredChecks, allChecks: checks.map((c) => c.name) }
        });

        return {
          allPassed: false,
          checks: relevantChecks,
          pending: true,
          failed: false
        };
      }

      const pending = relevantChecks.some(
        (check) => check.status !== 'completed'
      );

      const failed = relevantChecks.some(
        (check) =>
          check.conclusion === 'failure' ||
          check.conclusion === 'cancelled' ||
          check.conclusion === 'timed_out' ||
          check.conclusion === 'action_required'
      );

      const allPassed =
        !pending &&
        !failed &&
        relevantChecks.every((check) => check.conclusion === 'success');

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_POLL',
        state: 'CI_PENDING',
        status: allPassed ? 'success' : pending ? 'in_progress' : 'failed',
        message: `CI poll result: allPassed=${allPassed}, pending=${pending}, failed=${failed}`,
        metadata: { prNumber, headSha, checks: relevantChecks }
      });

      return {
        allPassed,
        checks: relevantChecks,
        pending,
        failed
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown error polling CI checks';

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_POLL',
        state: 'CI_PENDING',
        status: 'error',
        message: `Failed to poll CI checks: ${errorMessage}`,
        metadata: { prNumber, headSha, error: errorMessage }
      });

      throw new Error(`CI polling failed: ${errorMessage}`);
    }
  }
}
