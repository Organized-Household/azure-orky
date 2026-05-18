import { getPool } from '../../db/dbClient.js';
import { AuditLogger } from '../../audit/auditLogger.js';
import { CIPoller, CIPollerConfig, CIPollerResult } from './ciPoller.js';
import type { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

type WorkflowRun = RestEndpointMethodTypes['actions']['listWorkflowRunsForRepo']['response']['data']['workflow_runs'][0];

export interface CIStatusMonitorConfig {
  executionId: string;
  storyId: string;
  owner: string;
  repo: string;
  headSha: string;
  requiredChecks: string[];
  octokit: Octokit;
}

export class CIStatusMonitor {
  private config: CIStatusMonitorConfig;
  private auditLogger: AuditLogger;

  constructor(config: CIStatusMonitorConfig) {
    this.config = config;
    this.auditLogger = new AuditLogger(getPool());
  }

  async monitor(): Promise<CIPollerResult> {
    const { executionId, storyId, owner, repo, headSha, requiredChecks } = this.config;

    const runs = await this.getWorkflowRuns();
    const statuses = runs.map((r: WorkflowRun) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion
    }));

    const allFound = requiredChecks.every((name: string) => statuses.some((s) => s.name === name));
    if (!allFound) {
      const missing = requiredChecks.filter((name: string) => !statuses.some((s) => s.name === name));
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'ci_monitor_missing_checks',
        state: 'CI_PENDING',
        status: 'WARN',
        message: `Required checks not yet found: ${missing.join(', ')}`,
        metadata: { missing }
      });
    }

    const pollerConfig: CIPollerConfig = {
      ...this.config,
      pollIntervalMs: 30000,
      timeoutMs: 45 * 60 * 1000
    };

    const poller = new CIPoller(pollerConfig);
    return poller.poll();
  }

  private async getWorkflowRuns(): Promise<WorkflowRun[]> {
    const { owner, repo, headSha, octokit } = this.config;
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: headSha,
      per_page: 100
    });
    return data.workflow_runs.filter((r: WorkflowRun) => r.head_sha === headSha);
  }
}
