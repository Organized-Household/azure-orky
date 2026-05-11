import { createOctokit } from './githubClient';

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface CiStatusResult {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  allPassed: boolean;
  failedChecks: CheckRunSummary[];
}

export class CiStatusMonitor {
  async fetchStatus(
    repositoryOwner: string,
    repositoryName: string,
    commitSha: string,
  ): Promise<CiStatusResult> {
    const octokit = createOctokit();
    const { data } = await octokit.checks.listForRef({
      owner: repositoryOwner,
      repo: repositoryName,
      ref: commitSha,
    });

    const runs = data.check_runs;
    const failedChecks = runs.filter((r) => r.conclusion === 'failure');
    const pending = runs.filter((r) => r.status !== 'completed');

    return {
      total: runs.length,
      passed: runs.filter((r) => r.conclusion === 'success').length,
      failed: failedChecks.length,
      pending: pending.length,
      allPassed: failedChecks.length === 0 && pending.length === 0,
      failedChecks: failedChecks.map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion ?? null,
        detailsUrl: r.details_url ?? null,
      })),
    };
  }
}
