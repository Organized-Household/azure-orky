import { Octokit } from '@octokit/rest';
import { getPool } from '../../db/dbClient';

type WorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

export class CIStatusMonitor {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(octokit: Octokit, owner: string, repo: string) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  async getCheckStatus(
    headSha: string,
    requiredChecks: string[]
  ): Promise<{
    allComplete: boolean;
    allPassed: boolean;
    anyFailed: boolean;
    checks: Array<{ name: string; status: string; conclusion: string | null }>;
  }> {
    const { data: runs } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
      owner: this.owner,
      repo: this.repo,
      head_sha: headSha,
      per_page: 100
    });

    const checks = runs.workflow_runs.map((r: WorkflowRun) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion
    }));

    const requiredRuns = runs.workflow_runs.filter((r: WorkflowRun) =>
      requiredChecks.includes(r.name)
    );

    const allComplete = requiredRuns.every((r: WorkflowRun) => r.status === 'completed');
    const allPassed = requiredRuns.every((r: WorkflowRun) => r.conclusion === 'success');
    const anyFailed = requiredRuns.some(
      (r: WorkflowRun) =>
        r.conclusion === 'failure' ||
        r.conclusion === 'cancelled' ||
        r.conclusion === 'timed_out' ||
        r.conclusion === 'action_required'
    );

    return {
      allComplete,
      allPassed,
      anyFailed,
      checks
    };
  }

  async recordCheckStatus(
    executionId: string,
    prUrl: string,
    headSha: string,
    status: string,
    checks: Array<{ name: string; status: string; conclusion: string | null }>
  ): Promise<void> {
    const pool = getPool();

    await pool.query(
      `INSERT INTO ci_cd_status (execution_id, pr_url, head_sha, status, checks_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (execution_id)
       DO UPDATE SET
         pr_url = EXCLUDED.pr_url,
         head_sha = EXCLUDED.head_sha,
         status = EXCLUDED.status,
         checks_json = EXCLUDED.checks_json,
         updated_at = NOW()`,
      [executionId, prUrl, headSha, status, JSON.stringify(checks)]
    );
  }
}
