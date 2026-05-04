import { AuditLogger } from "../audit/auditLogger";
import { ExecutionRepository } from "../db/repositories/executionRepository";
import { EXECUTION_STATES, StoryPayload } from "../domain/storyPayload";
import { StoryRetrievalService } from "../integrations/jira/storyRetrievalService";
import { JiraWebhookValidationResult } from "../webhooks/jiraWebhookValidator";

export interface IntakeSuccess {
  received: true;
  executionId: string;
  storyId: string;
  status: "STORY_FETCHED";
  storyPayload: StoryPayload;
}

export class ExecutionFactory {
  constructor(
    private readonly executionRepository = new ExecutionRepository(),
    private readonly auditLogger = new AuditLogger(),
    private readonly storyRetrievalService?: StoryRetrievalService,
  ) {}

  async createRejectedExecution(
    validation: Extract<JiraWebhookValidationResult, { kind: "invalid" }>,
  ): Promise<void> {
    if (!validation.issueId || !validation.storyId) {
      return;
    }

    const execution = await this.executionRepository.create({
      storyId: validation.storyId,
      issueId: validation.issueId,
      projectKey: validation.projectKey,
      status: EXECUTION_STATES.FAILED,
      currentState: EXECUTION_STATES.FAILED,
      failureReason: validation.missingFields.join(", "),
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "webhook_received",
      state: EXECUTION_STATES.RECEIVED,
      status: EXECUTION_STATES.RECEIVED,
      message: "Jira webhook received",
      metadata: {
        webhookEvent: validation.webhookEvent,
        targetStatus: validation.targetStatus,
      },
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "webhook_rejected",
      state: EXECUTION_STATES.FAILED,
      status: EXECUTION_STATES.FAILED,
      message: "Jira webhook payload failed validation",
      metadata: {
        missingFields: validation.missingFields,
      },
    });
  }

  async createValidatedExecution(
    validation: Extract<JiraWebhookValidationResult, { kind: "valid" }>,
  ): Promise<IntakeSuccess> {
    const execution = await this.executionRepository.create({
      storyId: validation.storyId,
      issueId: validation.issueId,
      epicId: validation.epicId,
      projectKey: validation.projectKey,
      status: EXECUTION_STATES.RECEIVED,
      currentState: EXECUTION_STATES.RECEIVED,
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "webhook_received",
      state: EXECUTION_STATES.RECEIVED,
      status: EXECUTION_STATES.RECEIVED,
      message: "Jira webhook received",
      metadata: {
        webhookEvent: validation.webhookEvent,
        targetStatus: validation.targetStatus,
      },
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "execution_created",
      state: EXECUTION_STATES.RECEIVED,
      status: EXECUTION_STATES.RECEIVED,
      message: "Execution record created",
    });

    await this.executionRepository.updateState(
      execution.executionId,
      EXECUTION_STATES.VALIDATED,
    );

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "webhook_validated",
      state: EXECUTION_STATES.VALIDATED,
      status: EXECUTION_STATES.VALIDATED,
      message: "Jira webhook payload validated",
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "jira_story_fetch_started",
      state: EXECUTION_STATES.VALIDATED,
      status: EXECUTION_STATES.VALIDATED,
      message: "Fetching full Jira story",
      metadata: {
        issueId: validation.issueId,
      },
    });

    try {
      const storyRetrievalService =
        this.storyRetrievalService ?? new StoryRetrievalService();
      const storyPayload = await storyRetrievalService.retrieve(validation.issueId);

      await this.executionRepository.updateState(
        execution.executionId,
        EXECUTION_STATES.STORY_FETCHED,
      );

      await this.auditLogger.log({
        executionId: execution.executionId,
        storyId: storyPayload.storyId,
        step: "jira_story_fetch_succeeded",
        state: EXECUTION_STATES.STORY_FETCHED,
        status: EXECUTION_STATES.STORY_FETCHED,
        message: "Full Jira story fetched and normalized",
        metadata: {
          issueId: storyPayload.issueId,
          projectKey: storyPayload.projectKey,
          epicId: storyPayload.epicId,
        },
      });

      return {
        received: true,
        executionId: execution.executionId,
        storyId: storyPayload.storyId,
        status: EXECUTION_STATES.STORY_FETCHED,
        storyPayload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.executionRepository.updateState(
        execution.executionId,
        EXECUTION_STATES.FAILED,
        message,
      );

      await this.auditLogger.log({
        executionId: execution.executionId,
        storyId: execution.storyId,
        step: "jira_story_fetch_failed",
        state: EXECUTION_STATES.FAILED,
        status: EXECUTION_STATES.FAILED,
        message: "Full Jira story fetch failed",
        metadata: {
          error: message,
          issueId: validation.issueId,
        },
      });

      throw error;
    }
  }
}
