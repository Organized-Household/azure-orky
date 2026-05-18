import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../../db/dbClient.js';
import { AuditLogger } from '../../audit/auditLogger.js';
import type { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

type WorkflowRun = RestEndpointMethodTypes['actions']['listWorkflowRunsForRepo']['response']['data']['workflow_runs'][0];

export interface CIPollerConfig {
  executionId: string;
  storyId: string;
  owner: string;
  repo: string;
  headSha: string;
  requiredChecks: string[];
  pollIntervalMs: number;
  timeoutMs: number;
  octokit: Octokit;
}

export interface CIPollerResult {
  success: boolean;
  allPassed: boolean;
  timedOut: boolean;
  checks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>;
  error?: string;
}

export class CIPoller {
  private config: CIPollerConfig;
  private auditLogger: AuditLogger;
  private startTime: number;

  constructor(config: CIPollerConfig) {
    this.config = config;
    this.auditLogger = new AuditLogger(getPool());
    this.startTime = Date.now();
  }

  async poll(): Promise<CIPollerResult> {
    const { executionId, storyId, owner, repo, headSha, requiredChecks, pollIntervalMs, timeoutMs, octokit } = this.config;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'ci_poll_start',
      state: 'CI_PENDING',
      status: 'INFO',
      message: `Starting CI poll for ${owner}/${repo}@${headSha}`,
      metadata: { requiredChecks, pollIntervalMs, timeoutMs }
    });

    while (true) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed > timeoutMs) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'ci_poll_timeout',
          state: 'CI_PENDING',
          status: 'ERROR',
          message: `CI polling timed out after ${elapsed}ms`
        });
        return {
          success: false,
          allPassed: false,
          timedOut: true,
          checks: [],
          error: `CI polling timed out after ${elapsed}ms`
        };
      }

      try {
        const result = await this.checkStatus();
        if (result.success && result.allPassed) {
          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'ci_poll_success',
            state: 'CI_PASSED',
            status: 'SUCCESS',
            message: 'All required CI checks passed',
            metadata: { checks: result.checks }
          });
          return result;
        }

        if (result.success === false && !result.timedOut) {
          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'ci_poll_failure',
            state: 'CI_PENDING',
            status: 'ERROR',
            message: 'CI checks failed',
            metadata: { checks: result.checks }
          });
          return result;
        }

        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'ci_poll_pending',
          state: 'CI_PENDING',
          status: 'INFO',
          message: `CI checks still pending, retrying in ${pollIntervalMs}ms`,
          metadata: { checks: result.checks, elapsed }
        });

        await this.sleep(pollIntervalMs);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[CIPoller] Error polling CI status:', errorMessage);
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'ci_poll_error',
          state: 'CI_PENDING',
          status: 'ERROR',
          message: `Error polling CI: ${errorMessage}`
        });
        return {
          success: false,
          allPassed: false,
          timedOut: false,
          checks: [],
          error: errorMessage
        };
      }
    }
  }

  private async checkStatus(): Promise<CIPollerResult> {
    const { owner, repo, headSha, requiredChecks, octokit } = this.config;

    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: headSha,
      per_page: 100
    });

    const relevantRuns = data.workflow_runs.filter((run: WorkflowRun) => run.head_sha === headSha);

    const checks = relevantRuns.map((run: WorkflowRun) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion
    }));

    const requiredCheckStatuses = requiredChecks.map((name: string) => {
      const found = checks.find((c) => c.name === name);
      return {
        name,
        status: found?.status || 'not_found',
        conclusion: found?.conclusion || null
      };
    });

    const allCompleted = requiredCheckStatuses.every((c) => c.status === 'completed');
    const allPassed = requiredCheckStatuses.every((c) => c.conclusion === 'success');
    const anyFailed = requiredCheckStatuses.some((c) =>
      c.conclusion === 'failure' ||
      c.conclusion === 'cancelled' ||
      c.conclusion === 'timed_out' ||
      c.conclusion === 'action_required'
    );

    if (anyFailed) {
      return {
        success: false,
        allPassed: false,
        timedOut: false,
        checks: requiredCheckStatuses,
        error: 'One or more required checks failed'
      };
    }

    if (allCompleted && allPassed) {
      return {
        success: true,
        allPassed: true,
        timedOut: false,
        checks: requiredCheckStatuses
      };
    }

    return {
      success: true,
      allPassed: false,
      timedOut: false,
      checks: requiredCheckStatuses
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
