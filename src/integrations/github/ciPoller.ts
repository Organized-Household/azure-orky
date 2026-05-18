import { getPool } from '../../db/dbClient';
import { Octokit } from '@octokit/rest';

export interface CIStatusResult {
  allChecksPassed: boolean;
  hasFailedChecks: boolean;
  pendingChecks: string[];
  failedChecks: string[];
  status: 'pending' | 'success' | 'failure' | 'timeout';
}

export interface CIPollerConfig {
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
  pollIntervalMs: number;
  timeoutMs: number;
}

export class CIPoller {
  private octokit: Octokit;
  private config: CIPollerConfig;
  private startTime: number;

  constructor(octokit: Octokit, config: CIPollerConfig) {
    this.octokit = octokit;
    this.config = config;
    this.startTime = Date.now();
  }

  async poll(): Promise<CIStatusResult> {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.config.timeoutMs) {
      return {
        allChecksPassed: false,
        hasFailedChecks: false,
        pendingChecks: this.config.requiredChecks,
        failedChecks: [],
        status: 'timeout'
      };
    }

    try {
      const { data } = await this.octokit.checks.listForRef({
        owner: this.config.owner,
        repo: this.config.repo,
        ref: this.config.ref
      });

      const checkRuns = data.check_runs;
      const requiredCheckNames = new Set(this.config.requiredChecks);
      const foundChecks = new Map<string, string>();

      for (const run of checkRuns) {
        if (requiredCheckNames.has(run.name)) {
          foundChecks.set(run.name, run.conclusion || run.status || 'pending');
        }
      }

      const pendingChecks: string[] = [];
      const failedChecks: string[] = [];
      let allFound = true;
      let allPassed = true;

      for (const checkName of this.config.requiredChecks) {
        const conclusion = foundChecks.get(checkName);
        if (!conclusion || conclusion === 'pending' || conclusion === 'queued' || conclusion === 'in_progress') {
          pendingChecks.push(checkName);
          allPassed = false;
          if (!conclusion) {
            allFound = false;
          }
        } else if (conclusion !== 'success') {
          failedChecks.push(checkName);
          allPassed = false;
        }
      }

      const hasFailedChecks = failedChecks.length > 0;
      const hasPendingChecks = pendingChecks.length > 0;

      let status: 'pending' | 'success' | 'failure' | 'timeout';
      if (allPassed && allFound) {
        status = 'success';
      } else if (hasFailedChecks) {
        status = 'failure';
      } else {
        status = 'pending';
      }

      return {
        allChecksPassed: allPassed && allFound,
        hasFailedChecks,
        pendingChecks,
        failedChecks,
        status
      };
    } catch (err: unknown) {
      console.error('[CIPoller] Error polling checks:', err);
      throw err;
    }
  }

  async pollUntilComplete(): Promise<CIStatusResult> {
    while (true) {
      const result = await this.poll();
      if (result.status === 'success' || result.status === 'failure' || result.status === 'timeout') {
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }
}
