import { getPool } from '../../db/dbClient';
import { Octokit } from '@octokit/rest';

interface CIPollContext {
  executionId: string;
  owner: string;
  repo: string;
  prNumber: number;
  requiredChecks: string[];
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export class CIPoller {
  private octokit: Octokit;
  private pollIntervalMs: number;
  private maxPollDurationMs: number;

  constructor(octokit: Octokit, pollIntervalMs = 30000, maxPollDurationMs = 2700000) {
    this.octokit = octokit;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollDurationMs = maxPollDurationMs;
  }

  async pollUntilComplete(
    context: CIPollContext
  ): Promise<{ success: boolean; checks: CheckRun[]; timedOut: boolean }> {
    const startTime = Date.now();
    const { executionId, owner, repo, prNumber, requiredChecks } = context;

    console.log(`[CIPoller] Starting poll for execution ${executionId}, PR #${prNumber}`);

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > this.maxPollDurationMs) {
        console.error(
          `[CIPoller] Timeout after ${elapsed}ms for execution ${executionId}`
        );
        return { success: false, checks: [], timedOut: true };
      }

      try {
        const prData = await this.octokit.pulls.get({
          owner,
          repo,
          pull_number: prNumber
        });

        const headSha = prData.data.head.sha;

        const { data: checkRuns } = await this.octokit.checks.listForRef({
          owner,
          repo,
          ref: headSha
        });

        const relevantChecks = checkRuns.check_runs.filter((run: CheckRun) =>
          requiredChecks.includes(run.name)
        );

        console.log(
          `[CIPoller] Execution ${executionId}: Found ${relevantChecks.length} required checks`
        );

        const allComplete = relevantChecks.every(
          (run: CheckRun) => run.status === 'completed'
        );

        if (!allComplete) {
          console.log(
            `[CIPoller] Execution ${executionId}: Checks still pending, waiting ${this.pollIntervalMs}ms`
          );
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const allSuccess = relevantChecks.every(
          (run: CheckRun) => run.conclusion === 'success'
        );

        if (allSuccess) {
          console.log(
            `[CIPoller] Execution ${executionId}: All required checks passed`
          );
          return { success: true, checks: relevantChecks, timedOut: false };
        } else {
          const failed = relevantChecks.filter(
            (run: CheckRun) => run.conclusion !== 'success'
          );
          console.error(
            `[CIPoller] Execution ${executionId}: ${failed.length} checks failed:`,
            failed.map((run: CheckRun) => `${run.name}: ${run.conclusion}`)
          );
          return { success: false, checks: relevantChecks, timedOut: false };
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error(
            `[CIPoller] Error polling checks for execution ${executionId}:`,
            err.message
          );
        } else {
          console.error(
            `[CIPoller] Unknown error polling checks for execution ${executionId}`
          );
        }
        throw err;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
