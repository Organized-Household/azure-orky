import { JiraClient } from './jiraClient';
import { AuditLogger } from '../../audit/auditLogger';

export interface JiraFailureReportParams {
  executionId: string;
  storyId: string;
  issueKey: string;
  failedAtState: string;
  failureReason: string;
  prUrl?: string;
}

export class FailureReporter {
  private jiraClient: JiraClient;

  constructor(
    private readonly auditLogger: AuditLogger,
    jiraClient?: JiraClient,
  ) {
    this.jiraClient = jiraClient ?? new JiraClient();
  }

  // Never throws — every Jira call is individually guarded.
  async reportFailure(params: JiraFailureReportParams): Promise<void> {
    const { executionId, storyId, issueKey, failedAtState, failureReason, prUrl } = params;

    const lines = [
      `Orky: Execution failed at state ${failedAtState}.`,
      `Reason: ${failureReason}`,
      `Execution ID: ${executionId}`,
    ];
    if (prUrl) {
      lines.push(`Pull Request (left open for inspection): ${prUrl}`);
    }
    const commentText = lines.join('\n');

    try {
      await this.jiraClient.addComment(issueKey, commentText);

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'jira_failure_comment_posted',
        state: 'FAILED',
        status: 'success',
        message: `Failure comment posted to Jira story ${issueKey}`,
      });
    } catch (err: unknown) {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'jira_failure_comment_failed',
        state: 'FAILED',
        status: 'warn',
        message: `Could not post failure comment to ${issueKey}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const failureTransitionId = process.env.JIRA_FAILURE_TRANSITION_ID;
    if (failureTransitionId) {
      try {
        await this.jiraClient.transitionIssue(issueKey, failureTransitionId);

        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'jira_failure_transition_done',
          state: 'FAILED',
          status: 'success',
          message: `Jira story ${issueKey} transitioned to failure status (transitionId=${failureTransitionId})`,
        });
      } catch (err: unknown) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'jira_failure_transition_failed',
          state: 'FAILED',
          status: 'warn',
          message: `Could not transition ${issueKey}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'jira_failure_transition_skipped',
        state: 'FAILED',
        status: 'info',
        message: `JIRA_FAILURE_TRANSITION_ID not set — status transition skipped for ${issueKey}`,
      });
    }
  }
}
