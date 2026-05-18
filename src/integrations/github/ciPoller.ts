import { Octokit } from '@octokit/rest';
import { getPool } from '../../db/dbClient';
import { CIPollerConfig } from '../../types/ciPoller';

type WorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

export class CIPoller {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private pollIntervalSeconds: number;
  private maxPollMinutes: number;

  constructor(
    octokit: Octokit,
    owner: string,
    repo: string,
    pollIntervalSeconds: number = 30,
    maxPollMinutes: number = 45
  ) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.pollIntervalSeconds = pollIntervalSeconds;
    this.maxPollMinutes = maxPollMinutes;
  }

  async pollUntilComplete(
    executionId: string,
    prNumber: number,
    headSha: string,
    requiredChecks: string[]
  ): Promise<{
    success: boolean;
    status: string;
    checks: Array<{ name: string; status: string; conclusion: string | null }>;
    timedOut: boolean;
  }> {
    const pool = getPool();
    const startTime = Date.now();
    const maxPollMs = this.maxPollMinutes * 60 * 1000;

    console.log(
      `[CIPoller] Starting poll for execution ${executionId}, PR #${prNumber}, head SHA ${headSha}`
    );

    while (Date.now() - startTime < maxPollMs) {
      try {
        const { data: runs } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
          owner: this.owner,
          repo: this.repo,
          head_sha: headSha,
          per_page: 100
        });

        if (runs.workflow_runs.length === 0) {
          console.log(
            `[CIPoller] No workflow runs found for SHA ${headSha}, waiting...`
          );
          await this.sleep(this.pollIntervalSeconds * 1000);
          continue;
        }

        const checks = runs.workflow_runs.map((run: WorkflowRun) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion
        }));

        const requiredRuns = runs.workflow_runs.filter((run: WorkflowRun) =>
          requiredChecks.includes(run.name)
        );

        if (requiredRuns.length < requiredChecks.length) {
          const foundNames = requiredRuns.map((r: WorkflowRun) => r.name);
          const missing = requiredChecks.filter(name => !foundNames.includes(name));
          console.log(
            `[CIPoller] Waiting for required checks: ${missing.join(', ')}`
          );
          await this.sleep(this.pollIntervalSeconds * 1000);
          continue;
        }

        const allCompleted = requiredRuns.every(
          (run: WorkflowRun) => run.status === 'completed'
        );

        if (!allCompleted) {
          console.log(
            `[CIPoller] Some checks still running for execution ${executionId}`
          );
          await this.sleep(this.pollIntervalSeconds * 1000);
          continue;
        }

        const allSucceeded = requiredRuns.every(
          (run: WorkflowRun) => run.conclusion === 'success'
        );

        const anyFailed = requiredRuns.some(
          (run: WorkflowRun) =>
            run.conclusion === 'failure' ||
            run.conclusion === 'cancelled' ||
            run.conclusion === 'timed_out' ||
            run.conclusion === 'action_required'
        );

        if (anyFailed) {
          console.log(
            `[CIPoller] Required checks failed for execution ${executionId}`
          );
          await pool.query(
            `UPDATE ci_cd_status SET status = $1, checks_json = $2, updated_at = NOW() WHERE execution_id = $3`,
            ['failed', JSON.stringify(checks), executionId]
          );
          return {
            success: false,
            status: 'failed',
            checks,
            timedOut: false
          };
        }

        if (allSucceeded) {
          console.log(
            `[CIPoller] All required checks passed for execution ${executionId}`
          );
          await pool.query(
            `UPDATE ci_cd_status SET status = $1, checks_json = $2, updated_at = NOW() WHERE execution_id = $3`,
            ['success', JSON.stringify(checks), executionId]
          );
          return {
            success: true,
            status: 'success',
            checks,
            timedOut: false
          };
        }

        await this.sleep(this.pollIntervalSeconds * 1000);
      } catch (err: unknown) {
        console.error(
          `[CIPoller] Error polling checks for execution ${executionId}:`,
          err instanceof Error ? err.message : String(err)
        );
        await this.sleep(this.pollIntervalSeconds * 1000);
      }
    }

    console.log(
      `[CIPoller] Polling timed out after ${this.maxPollMinutes} minutes for execution ${executionId}`
    );

    const { data: runs } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
      owner: this.owner,
      repo: this.repo,
      head_sha: headSha,
      per_page: 100
    });

    const checks = runs.workflow_runs.map((run: WorkflowRun) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion
    }));

    await pool.query(
      `UPDATE ci_cd_status SET status = $1, checks_json = $2, updated_at = NOW() WHERE execution_id = $3`,
      ['timeout', JSON.stringify(checks), executionId]
    );

    return {
      success: false,
      status: 'timeout',
      checks,
      timedOut: true
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
