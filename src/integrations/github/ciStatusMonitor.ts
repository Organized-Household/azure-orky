import { getPool } from '../../db/dbClient.js';
import { AuditLogger } from '../../audit/auditLogger.js';
import { CICheckRun } from '../../domain/ciStatus.js';

export interface CIStatusResult {
  allPassed: boolean;
  checkRuns: CICheckRun[];
  status: 'success' | 'failure' | 'pending';
}

export class CIStatusMonitor {
  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.auditLogger = auditLogger;
  }

  async checkStatus(
    executionId: string,
    owner: string,
    repo: string,
    ref: string,
    requiredChecks: string[]
  ): Promise<CIStatusResult> {
    console.log(`[CIStatusMonitor] Checking CI status for ${owner}/${repo}@${ref}`);

    try {
      const runs = await this.fetchCheckRuns(owner, repo, ref);

      const relevantRuns = runs.filter((r: { name: string }) => requiredChecks.includes(r.name));

      if (relevantRuns.length === 0) {
        return {
          allPassed: false,
          checkRuns: [],
          status: 'pending'
        };
      }

      const allCompleted = relevantRuns.every((r: { status: string }) => r.status === 'completed');

      if (!allCompleted) {
        return {
          allPassed: false,
          checkRuns: relevantRuns.map((r: { name: string; status: string; conclusion: string }) => ({
            name: r.name,
            status: r.status,
            conclusion: r.conclusion
          })),
          status: 'pending'
        };
      }

      const allPassed = relevantRuns.every((r: { conclusion: string }) => r.conclusion === 'success');

      const mappedRuns: CICheckRun[] = relevantRuns.map((r: { name: string; status: string; conclusion: string }) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion
      }));

      return {
        allPassed,
        checkRuns: mappedRuns,
        status: allPassed ? 'success' : 'failure'
      };
    } catch (err: unknown) {
      console.error('[CIStatusMonitor] Error checking CI status:', err);
      await this.auditLogger.log({
        executionId,
        storyId: '',
        step: 'ci_status_check_error',
        state: 'CI_PENDING',
        status: 'failed',
        message: err instanceof Error ? err.message : 'Unknown error checking CI status',
        metadata: { owner, repo, ref }
      });
      throw err;
    }
  }

  private async fetchCheckRuns(
    owner: string,
    repo: string,
    ref: string
  ): Promise<Array<{ name: string; status: string; conclusion: string }>> {
    console.log(`[CIStatusMonitor] Fetching check runs for ${owner}/${repo}@${ref}`);
    return [];
  }
}
