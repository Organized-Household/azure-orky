import { getPool } from '../../db/dbClient';
import { Octokit } from '@octokit/rest';
import { CIPoller, CIPollerConfig, CIStatusResult } from './ciPoller';

export interface MonitorConfig {
  executionId: string;
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class CIStatusMonitor {
  private octokit: Octokit;
  private executionId: string;

  constructor(octokit: Octokit, executionId: string) {
    this.octokit = octokit;
    this.executionId = executionId;
  }

  async monitor(config: MonitorConfig): Promise<CIStatusResult> {
    const pollerConfig: CIPollerConfig = {
      owner: config.owner,
      repo: config.repo,
      ref: config.ref,
      requiredChecks: config.requiredChecks,
      pollIntervalMs: config.pollIntervalMs || 30000,
      timeoutMs: config.timeoutMs || 2700000
    };

    const poller = new CIPoller(this.octokit, pollerConfig);
    const result = await poller.pollUntilComplete();

    await this.persistCIStatus(result);
    return result;
  }

  private async persistCIStatus(result: CIStatusResult): Promise<void> {
    const pool = getPool();
    try {
      await pool.query(
        `UPDATE executions SET ci_status = $1, updated_at = NOW() WHERE execution_id = $2`,
        [result.status, this.executionId]
      );
    } catch (err: unknown) {
      console.error('[CIStatusMonitor] Error persisting CI status:', err);
      throw err;
    }
  }
}
