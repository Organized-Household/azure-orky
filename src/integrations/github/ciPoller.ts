import { Octokit } from '@octokit/rest';
import { AuditLogger } from '../../audit/auditLogger';

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | null;

export interface CiPollResult {
  allPassed: boolean;
  failureReason?: string;
  checkSummary: Array<{ name: string; status: string; conclusion: CheckConclusion }>;
}

const FAILING_CONCLUSIONS: CheckConclusion[] = [
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
];

const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_DURATION_MS = 45 * 60 * 1000;

export class CiPoller {
  constructor(
    private readonly octokit: Octokit,
    private readonly auditLogger: AuditLogger,
  ) {}

  async pollUntilComplete(params: {
    executionId: string;
    storyId: string;
    owner: string;
    repo: string;
    ref: string;
  }): Promise<CiPollResult> {
    const { executionId, storyId, owner, repo, ref } = params;
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let pollCount = 0;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'ci_poll_started',
      state: 'CI_PENDING',
      status: 'info',
      message: `Starting CI poll for ref ${ref.slice(0, 7)}. Interval: ${POLL_INTERVAL_MS / 1000}s, timeout: 45m.`,
    });

    while (Date.now() < deadline) {
      pollCount++;

      const checkSummary = await this.fetchCheckSummary({ owner, repo, ref });

      const allComplete = checkSummary.every((c) => c.status === 'completed');
      const anyFailed = checkSummary.some(
        (c) => c.status === 'completed' && FAILING_CONCLUSIONS.includes(c.conclusion),
      );

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'ci_poll_tick',
        state: 'CI_PENDING',
        status: 'info',
        message: `Poll #${pollCount}: ${checkSummary.length} check(s). allComplete=${allComplete} anyFailed=${anyFailed}`,
        metadata: { checkSummary },
      });

      if (anyFailed) {
        const failed = checkSummary.filter((c) => FAILING_CONCLUSIONS.includes(c.conclusion));
        const failureReason = `CI checks failed: ${failed.map((c) => `${c.name}=${c.conclusion}`).join(', ')}`;
        return { allPassed: false, failureReason, checkSummary };
      }

      if (allComplete) {
        return { allPassed: true, checkSummary };
      }

      if (Date.now() + POLL_INTERVAL_MS < deadline) {
        await this.sleep(POLL_INTERVAL_MS);
      } else {
        break;
      }
    }

    const finalSummary = await this.fetchCheckSummary({ owner, repo, ref });
    const pendingChecks = finalSummary.filter((c) => c.status !== 'completed');
    const failureReason = `CI polling timed out after 45 minutes. Still pending: ${pendingChecks.map((c) => c.name).join(', ') || 'unknown'}`;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'ci_poll_timeout',
      state: 'CI_PENDING',
      status: 'error',
      message: failureReason,
      metadata: { finalSummary },
    });

    return { allPassed: false, failureReason, checkSummary: finalSummary };
  }

  private async fetchCheckSummary(params: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<Array<{ name: string; status: string; conclusion: CheckConclusion }>> {
    const { data } = await this.octokit.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.ref,
      per_page: 100,
    });

    return data.check_runs.map((run: { name: string; status: string; conclusion: string | null }) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion as CheckConclusion,
    }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
