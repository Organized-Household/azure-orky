import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../../db/dbClient.js';
import { AuditLogger } from '../../audit/auditLogger.js';
import { CICheckRun } from '../../domain/ciStatus.js';

interface PollInput {
  executionId: string;
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
}

interface PollResult {
  allChecksPassed: boolean;
  checkRuns: CICheckRun[];
  status: 'success' | 'failure' | 'pending' | 'timeout';
}

export class CIPoller {
  private anthropic: Anthropic;
  private auditLogger: AuditLogger;
  private pollIntervalMs: number;
  private timeoutMs: number;

  constructor(anthropic: Anthropic, auditLogger: AuditLogger, pollIntervalMs = 30000, timeoutMs = 2700000) {
    this.anthropic = anthropic;
    this.auditLogger = auditLogger;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
  }

  async pollUntilComplete(input: PollInput): Promise<PollResult> {
    const startTime = Date.now();
    const { executionId, owner, repo, ref, requiredChecks } = input;

    console.log(`[CIPoller] Starting CI poll for execution ${executionId}, ref ${ref}`);

    await this.auditLogger.log({
      executionId,
      storyId: '',
      step: 'ci_poll_start',
      state: 'CI_PENDING',
      status: 'in_progress',
      message: `Starting CI poll for ref ${ref}`,
      metadata: { owner, repo, ref, requiredChecks }
    });

    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed > this.timeoutMs) {
        console.error(`[CIPoller] Timeout after ${elapsed}ms for execution ${executionId}`);
        await this.auditLogger.log({
          executionId,
          storyId: '',
          step: 'ci_poll_timeout',
          state: 'CI_PENDING',
          status: 'failed',
          message: 'CI polling timeout exceeded',
          metadata: { elapsedMs: elapsed, timeoutMs: this.timeoutMs }
        });
        return {
          allChecksPassed: false,
          checkRuns: [],
          status: 'timeout'
        };
      }

      try {
        const checkResult = await this.fetchCheckRuns(owner, repo, ref);

        const relevantChecks = checkResult.runs.filter((run: { name: string }) =>
          requiredChecks.includes(run.name)
        );

        if (relevantChecks.length === 0) {
          console.log(`[CIPoller] No required checks found yet for ${ref}, waiting...`);
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const allCompleted = relevantChecks.every(
          (run: { status: string }) => run.status === 'completed'
        );

        if (!allCompleted) {
          console.log(`[CIPoller] Checks still pending for ${ref}, waiting...`);
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const allPassed = relevantChecks.every(
          (run: { conclusion: string }) => run.conclusion === 'success'
        );

        const mappedRuns: CICheckRun[] = relevantChecks.map((run: { name: string; status: string; conclusion: string }) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion
        }));

        if (allPassed) {
          console.log(`[CIPoller] All required checks passed for ${ref}`);
          await this.auditLogger.log({
            executionId,
            storyId: '',
            step: 'ci_poll_success',
            state: 'CI_PASSED',
            status: 'success',
            message: 'All required checks passed',
            metadata: { checkRuns: mappedRuns }
          });
          return {
            allChecksPassed: true,
            checkRuns: mappedRuns,
            status: 'success'
          };
        } else {
          console.error(`[CIPoller] Some required checks failed for ${ref}`);
          await this.auditLogger.log({
            executionId,
            storyId: '',
            step: 'ci_poll_failure',
            state: 'CI_PENDING',
            status: 'failed',
            message: 'One or more required checks failed',
            metadata: { checkRuns: mappedRuns }
          });
          return {
            allChecksPassed: false,
            checkRuns: mappedRuns,
            status: 'failure'
          };
        }
      } catch (err: unknown) {
        console.error('[CIPoller] Error fetching check runs:', err);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async fetchCheckRuns(owner: string, repo: string, ref: string): Promise<{ runs: Array<{ name: string; status: string; conclusion: string }> }> {
    console.log(`[CIPoller] Fetching check runs for ${owner}/${repo}@${ref}`);
    return { runs: [] };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
