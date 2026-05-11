import { Octokit } from '@octokit/rest';
import { AuditLogger } from '../audit/auditLogger';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { InstructionPacketRepository } from '../db/repositories/instructionPacketRepository';
import { RepoChangeSetRepository } from '../db/repositories/repoChangeSetRepository';
import { FailureReporter } from '../integrations/jira/failureReporter';
import { StoryPayload } from '../domain/storyPayload';

export interface HandleFailureParams {
  executionId: string;
  storyId: string;
  failedAtState: string;
  failureReason: string;
  storyPayload?: StoryPayload;
}

export class FailureHandler {
  constructor(
    private readonly executionRepository: ExecutionRepository,
    private readonly repoChangeSetRepository: RepoChangeSetRepository,
    private readonly instructionPacketRepository: InstructionPacketRepository,
    private readonly auditLogger: AuditLogger,
  ) {}

  /**
   * Handles all failure-path work. Never throws — every step is individually guarded.
   * 1. Transitions execution to FAILED and releases lock
   * 2. Closes open PR if one exists (STORY-7.2)
   * 3. Deletes branch if one exists (STORY-7.2)
   * 4. Reports failure to Jira if storyPayload is available (STORY-7.3)
   */
  async handle(params: HandleFailureParams): Promise<void> {
    const { executionId, storyId, failedAtState, failureReason, storyPayload } = params;

    try {
      await this.executionRepository.updateState(executionId, 'FAILED', failureReason);
    } catch (err: unknown) {
      console.error(
        `[FailureHandler] Could not transition execution ${executionId} to FAILED:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      await this.executionRepository.releaseLock(storyId);
    } catch (err: unknown) {
      console.error(
        `[FailureHandler] Could not release lock for story ${storyId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    await this.safeLog({
      executionId,
      storyId,
      step: 'pipeline_failed',
      state: 'FAILED',
      status: 'FAILED',
      message: `Execution failed at ${failedAtState}: ${failureReason}`,
      metadata: { failedAtState },
    });

    await this.closeOpenPrAndBranch(executionId, storyId, failedAtState);

    if (storyPayload?.jiraIssueKey) {
      await this.reportToJira(executionId, storyId, storyPayload.jiraIssueKey, failedAtState, failureReason);
    } else {
      await this.safeLog({
        executionId,
        storyId,
        step: 'jira_failure_report_skipped',
        state: 'FAILED',
        status: 'info',
        message: 'Jira failure report skipped — storyPayload not available at failure point',
      });
    }
  }

  private async closeOpenPrAndBranch(
    executionId: string,
    storyId: string,
    failedAtState: string,
  ): Promise<void> {
    let changeSet: Awaited<ReturnType<RepoChangeSetRepository['getPrDataByExecutionId']>>;
    try {
      changeSet = await this.repoChangeSetRepository.getPrDataByExecutionId(executionId);
    } catch (err: unknown) {
      await this.safeLog({
        executionId,
        storyId,
        step: 'cleanup_changeset_read_failed',
        state: 'FAILED',
        status: 'warn',
        message: `Could not read change set for cleanup: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (!changeSet) {
      await this.safeLog({
        executionId,
        storyId,
        step: 'cleanup_skipped',
        state: 'FAILED',
        status: 'info',
        message: `No change set found for execution ${executionId} — no PR or branch to clean up`,
      });
      return;
    }

    const { prUrl, branchName } = changeSet;

    if (!prUrl && !branchName) {
      await this.safeLog({
        executionId,
        storyId,
        step: 'cleanup_skipped',
        state: 'FAILED',
        status: 'info',
        message: 'No PR or branch recorded — cleanup not needed',
      });
      return;
    }

    // Resolve owner/repo from instruction_packets (target_repository = "owner/repo")
    let owner: string | undefined;
    let repo: string | undefined;

    try {
      const targetRepository = await this.instructionPacketRepository.getTargetRepositoryByExecutionId(executionId);
      if (targetRepository) {
        const parts = targetRepository.split('/');
        if (parts.length === 2) {
          [owner, repo] = parts;
        }
      }
    } catch (err: unknown) {
      console.error('[FailureHandler] Could not resolve targetRepository from instruction_packets:', err instanceof Error ? err.message : String(err));
    }

    if (!owner || !repo) {
      await this.safeLog({
        executionId,
        storyId,
        step: 'cleanup_skipped',
        state: 'FAILED',
        status: 'warn',
        message: 'Could not determine owner/repo from instruction_packets — PR and branch cleanup skipped',
      });
      return;
    }

    const octokit = new Octokit({ auth: process.env.GH_TOKEN });

    if (prUrl) {
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

      if (prNumber) {
        try {
          await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
          await this.safeLog({
            executionId,
            storyId,
            step: 'pr_closed_on_failure',
            state: 'FAILED',
            status: 'success',
            message: `PR #${prNumber} closed due to execution failure at ${failedAtState}`,
          });
        } catch (err: unknown) {
          await this.safeLog({
            executionId,
            storyId,
            step: 'pr_close_failed',
            state: 'FAILED',
            status: 'warn',
            message: `Failed to close PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    if (branchName) {
      try {
        await octokit.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
        await this.safeLog({
          executionId,
          storyId,
          step: 'branch_deleted_on_failure',
          state: 'FAILED',
          status: 'success',
          message: `Branch ${branchName} deleted due to execution failure at ${failedAtState}`,
        });
      } catch (err: unknown) {
        await this.safeLog({
          executionId,
          storyId,
          step: 'branch_delete_failed',
          state: 'FAILED',
          status: 'warn',
          message: `Failed to delete branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async reportToJira(
    executionId: string,
    storyId: string,
    jiraIssueKey: string,
    failedAtState: string,
    failureReason: string,
  ): Promise<void> {
    try {
      const changeSet = await this.repoChangeSetRepository.getPrDataByExecutionId(executionId);
      const prUrl = changeSet?.prUrl ?? undefined;

      const failureReporter = new FailureReporter(this.auditLogger);
      await failureReporter.reportFailure({
        executionId,
        storyId,
        issueKey: jiraIssueKey,
        failedAtState,
        failureReason,
        prUrl,
      });
    } catch (err: unknown) {
      await this.safeLog({
        executionId,
        storyId,
        step: 'jira_failure_report_error',
        state: 'FAILED',
        status: 'warn',
        message: `Unexpected error calling FailureReporter: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async safeLog(params: {
    executionId: string;
    storyId: string;
    step: string;
    state: string;
    status: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditLogger.log(params);
    } catch {
      console.error(`[FailureHandler] Audit log failed for step ${params.step}`);
    }
  }
}
