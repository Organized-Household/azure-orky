import { AuditLogger } from "../audit/auditLogger";
import { ExecutionRepository } from "../db/repositories/executionRepository";
import { InstructionPacketRepository } from "../db/repositories/instructionPacketRepository";
import { EXECUTION_STATES, StoryPayload } from "../domain/storyPayload";
import { ForgeClient } from "../integrations/forge/forgeClient";
import { InstructionValidator } from "../integrations/forge/instructionValidator";
import { StoryRetrievalService } from "../integrations/jira/storyRetrievalService";
import { ForgeOrchestrator } from "./forgeOrchestrator";
import { RepositoryMutationExecutor } from "../agents/repositoryMutationExecutor";
import { PrOrchestrator } from "../integrations/github/prOrchestrator";
import { JiraUpdater } from "../integrations/jira/jiraUpdater";
import { RepoChangeSetRepository } from "../db/repositories/repoChangeSetRepository";
import { DecisionLogRepository } from "../db/repositories/decisionLogRepository";
import { FailureHandler } from "./failureHandler";
import { JiraWebhookValidationResult } from "../webhooks/jiraWebhookValidator";
import { TokenUsageRepository } from "../db/repositories/tokenUsageRepository";

export interface IntakeSuccess {
  received: true;
  executionId: string;
  storyId: string;
  status: "COMPLETED";
  storyPayload: StoryPayload;
}

export interface IntakeIgnored {
  received: true;
  ignored: true;
  reason: string;
  storyId: string;
}

export class ExecutionFactory {
  constructor(
    private readonly executionRepository = new ExecutionRepository(),
    private readonly auditLogger = new AuditLogger(),
    private readonly storyRetrievalService?: StoryRetrievalService,
  ) {}

  async createRejectedExecution(
    validation: JiraWebhookValidationResult,
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
      failureReason: (validation.missingFields ?? []).join(", "),
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "webhook_received",
      state: EXECUTION_STATES.RECEIVED,
      status: EXECUTION_STATES.RECEIVED,
      message: "Jira webhook received",
      metadata: {
        targetStatus: validation.status,
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
    validation: JiraWebhookValidationResult,
  ): Promise<IntakeSuccess | IntakeIgnored> {
    const storyId = validation.storyId!;

    // Idempotency gate: if a non-failed execution already exists for this
    // story, silently ignore the trigger. This handles:
    // 1. Jira at-least-once webhook delivery (same event delivered twice)
    // 2. Non-status field edits on a story that completed a prior execution
    const alreadyProcessed = await this.executionRepository.hasActiveOrCompletedExecution(storyId);
    if (alreadyProcessed) {
      console.info(
        `[ExecutionFactory] Idempotency gate: execution already exists for story ${storyId} — ignoring trigger`,
      );
      return {
        received: true,
        ignored: true,
        reason: 'execution_already_exists',
        storyId,
      };
    }

    // Create execution record first so we have an executionId for the lock
    const execution = await this.executionRepository.create({
      storyId,
      issueId: validation.issueId!,
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
        targetStatus: validation.status,
      },
    });

    // Attempt to acquire the execution lock for this story
    const lockAcquired = await this.executionRepository.acquireLock(
      storyId,
      execution.executionId,
    );

    if (!lockAcquired) {
      // Another execution is already active for this story — mark this one failed and stop
      console.warn(
        `[ExecutionFactory] Duplicate trigger ignored for story ${storyId} — active execution lock exists`,
      );

      await this.executionRepository.updateState(
        execution.executionId,
        EXECUTION_STATES.FAILED,
        "Duplicate trigger: active execution already exists for this story",
      );

      await this.auditLogger.log({
        executionId: execution.executionId,
        storyId: execution.storyId,
        step: "duplicate_trigger_rejected",
        state: EXECUTION_STATES.FAILED,
        status: EXECUTION_STATES.FAILED,
        message: "Duplicate webhook trigger rejected — execution lock already held",
        metadata: {
          storyId,
        },
      });

      throw new Error(
        `Duplicate trigger: active execution already exists for story ${storyId}`,
      );
    }

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: execution.storyId,
      step: "execution_created",
      state: EXECUTION_STATES.RECEIVED,
      status: EXECUTION_STATES.RECEIVED,
      message: "Execution record created and lock acquired",
    });

    await this.executionRepository.updateState(
      execution.executionId,
      EXECUTION_STATES.VALIDATED,
    );

    let currentState: string = EXECUTION_STATES.VALIDATED;

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

    let storyPayload: StoryPayload | undefined;

    try {
      const storyRetrievalService =
        this.storyRetrievalService ?? new StoryRetrievalService(validation.projectKey ?? 'ORKY');
      storyPayload = await storyRetrievalService.retrieve(validation.issueId!);

      await this.executionRepository.updateState(
        execution.executionId,
        EXECUTION_STATES.STORY_FETCHED,
      );
      currentState = EXECUTION_STATES.STORY_FETCHED;

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

      const forgeOrchestrator = new ForgeOrchestrator(
        new ForgeClient(this.auditLogger),
        new InstructionValidator(),
        this.executionRepository,
        new InstructionPacketRepository(),
        this.auditLogger,
      );

      const packet = await forgeOrchestrator.run(execution.executionId, storyPayload);
      currentState = EXECUTION_STATES.PACKET_VALIDATED;

      // EPIC-3: Execute repository mutations
      const mutationExecutor = new RepositoryMutationExecutor();
      await mutationExecutor.execute(execution.executionId, storyPayload.storyId, packet, storyPayload.projectKey);
      currentState = EXECUTION_STATES.CHANGES_PREPARED;

      // EPIC-4 + 5: Branch, commit, PR, CI gate, auto-merge → COMPLETED
      const prOrchestrator = new PrOrchestrator();
      await prOrchestrator.run({
        executionId: execution.executionId,
        storyId: storyPayload.storyId,
        storyTitle: storyPayload.title,
        branchNameHint: packet.branchNameHint,
        targetRepository: packet.targetRepository,
        prTitle: packet.prTitle,
        prBody: packet.prBody,
        commitMessage: packet.commitMessage,
        projectKey: storyPayload.projectKey,
      });

      // STORY-6.1 + 6.2: Write back to Jira on success (non-blocking)
      try {
        const changeSetRepo = new RepoChangeSetRepository();
        const prData = await changeSetRepo.getPrDataByExecutionId(execution.executionId);
        if (prData?.prUrl && prData?.mergeSha) {
          const jiraUpdater = new JiraUpdater(this.auditLogger);
          await jiraUpdater.reportSuccess({
            executionId: execution.executionId,
            storyId: storyPayload.storyId,
            issueKey: storyPayload.jiraIssueKey,
            prUrl: prData.prUrl,
            mergeSha: prData.mergeSha,
          });
        }
      } catch (jiraErr: unknown) {
        // Jira write-back failure must not retroactively fail a COMPLETED execution
        await this.auditLogger.log({
          executionId: execution.executionId,
          storyId: storyPayload.storyId,
          step: "jira_success_update_failed",
          state: "COMPLETED",
          status: "warn",
          message: `Jira success update failed (execution already COMPLETED): ${jiraErr instanceof Error ? jiraErr.message : String(jiraErr)}`,
        });
      }

      // STORY-9.2: Write decision log after every COMPLETED execution (non-blocking)
      try {
        const changeSet = await new RepoChangeSetRepository().getPrDataByExecutionId(
          execution.executionId,
        );
        const decisionLogRepo = new DecisionLogRepository();
        await decisionLogRepo.write({
          executionId: execution.executionId,
          epicId: storyPayload.PDEEpicID ?? storyPayload.epicId ?? undefined,
          storyId: storyPayload.storyId,
          filesChanged: packet.fileOperations.map((op) => `${op.operation}: ${op.path}`).join('\n'),
          patternsUsed: packet.implementationSummary,
          migrationApplied:
            packet.fileOperations
              .filter((op) => op.path.startsWith('migrations/'))
              .map((op) => op.path)
              .join(', ') || undefined,
          summary:
            `Story: ${storyPayload.title}\n` +
            `PR: ${changeSet?.prUrl ?? 'unknown'}\n` +
            `Merge SHA: ${changeSet?.mergeSha ?? 'unknown'}\n` +
            `Files changed: ${packet.fileOperations.length}`,
        });
      } catch (decisionLogError: unknown) {
        const msg = decisionLogError instanceof Error ? decisionLogError.message : String(decisionLogError);
        await this.auditLogger.log({
          executionId: execution.executionId,
          storyId: storyPayload.storyId,
          step: 'decision_log_write_failed',
          state: 'COMPLETED',
          status: 'warn',
          message: `Decision log write failed (execution still COMPLETED): ${msg}`,
        });
      }

      try {
        const tokenSummary = await new TokenUsageRepository().sumByExecution(execution.executionId);
        await this.auditLogger.log({
          executionId: execution.executionId,
          storyId: storyPayload.storyId,
          step: 'token_usage_summary',
          state: 'COMPLETED',
          status: 'success',
          message: 'Pipeline completed successfully',
          metadata: tokenSummary,
        });
      } catch (tokenErr: unknown) {
        const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
        console.error('[ExecutionFactory] Failed to log token_usage_summary:', msg);
      }

      return {
        received: true,
        executionId: execution.executionId,
        storyId: storyPayload.storyId,
        status: 'COMPLETED',
        storyPayload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ExecutionFactory] Pipeline failed:", message);

      const failureHandler = new FailureHandler(
        this.executionRepository,
        new RepoChangeSetRepository(),
        new InstructionPacketRepository(),
        this.auditLogger,
      );

      await failureHandler.handle({
        executionId: execution.executionId,
        storyId: execution.storyId,
        failedAtState: currentState,
        failureReason: message,
        storyPayload,
      });

      throw error;
    }
  }
}