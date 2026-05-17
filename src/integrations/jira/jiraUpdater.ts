import { JiraClient } from './jiraClient';
import { AuditLogger } from '../../audit/auditLogger';
import { TokenUsageRepository, estimateCostUsd } from '../../db/repositories/tokenUsageRepository';

export interface JiraSuccessUpdateParams {
  executionId: string;
  storyId: string;
  issueKey: string;
  prUrl: string;
  mergeSha: string;
}

export class JiraUpdater {
  private jiraClient: JiraClient;

  constructor(
    private readonly auditLogger: AuditLogger,
    jiraClient?: JiraClient,
  ) {
    this.jiraClient = jiraClient ?? new JiraClient();
  }

  async reportSuccess(params: JiraSuccessUpdateParams): Promise<void> {
    const { executionId, storyId, issueKey, prUrl, mergeSha } = params;

    // Fetch token usage for cost summary — best-effort, never throws
    let costLine = '';
    try {
      const tokenRepo = new TokenUsageRepository();
      const usage = await tokenRepo.sumByExecution(executionId);
      if (usage.callCount > 0) {
        const costUsd = estimateCostUsd(usage.inputTokens, usage.outputTokens);
        costLine = `\nAPI usage: ~${usage.totalTokens} tokens (~$${costUsd.toFixed(2)} estimated)`;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[JiraUpdater] Failed to fetch token usage for cost summary:', error.message);
    }

    await this.jiraClient.addRemoteLink(issueKey, prUrl, 'Orky: Pull Request');

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'jira_pr_link_attached',
      state: 'COMPLETED',
      status: 'success',
      message: `PR link attached to Jira story ${issueKey}: ${prUrl}`,
    });

    const commentText =
      `Orky: Execution completed successfully.\n` +
      `Pull Request: ${prUrl}\n` +
      `Merge SHA: ${mergeSha}` +
      costLine;

    await this.jiraClient.addComment(issueKey, commentText);

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'jira_success_comment_posted',
      state: 'COMPLETED',
      status: 'success',
      message: `Success comment posted to Jira story ${issueKey}`,
    });

    const completionTransitionId = process.env.JIRA_COMPLETION_TRANSITION_ID;
    if (completionTransitionId) {
      await this.jiraClient.transitionIssue(issueKey, completionTransitionId);

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'jira_status_transitioned',
        state: 'COMPLETED',
        status: 'success',
        message: `Jira story ${issueKey} transitioned (transitionId=${completionTransitionId})`,
      });
    } else {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'jira_transition_skipped',
        state: 'COMPLETED',
        status: 'info',
        message: `JIRA_COMPLETION_TRANSITION_ID not set — status transition skipped for ${issueKey}`,
      });
    }
  }
}
