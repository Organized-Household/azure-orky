import { AuditLogger } from '../audit/auditLogger';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { DecisionLogRepository } from '../db/repositories/decisionLogRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { InstructionPacketRepository } from '../db/repositories/instructionPacketRepository';
import { PacketNegotiationRepository } from '../db/repositories/packetNegotiationRepository';
import { ProjectContextRepository } from '../db/repositories/projectContextRepository';
import { RepoChangeSetRepository } from '../db/repositories/repoChangeSetRepository';
import { InstructionPacket } from '../domain/instructionPacket';
import { EXECUTION_STATES, ExecutionState, StoryPayload } from '../domain/storyPayload';
import { RepositoryMutationExecutor } from '../agents/repositoryMutationExecutor';
import { BatchedForgeClient, BatchedDIP } from '../integrations/forge/batchedForgeClient';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
import { PacketReviewer } from '../integrations/review/packetReviewer';
import { PacketNegotiationOrchestrator } from './packetNegotiationOrchestrator';
import { PrOrchestrator } from '../integrations/github/prOrchestrator';
import { JiraUpdater } from '../integrations/jira/jiraUpdater';
import { StoryRetrievalService } from '../integrations/jira/storyRetrievalService';

export class BatchOrchestrator {
  constructor(
    private batchRepo: BatchExecutionRepository,
    private storyRetrieval: StoryRetrievalService,
    private forgePlanner: ForgePlannerClient,
    private batchedForgeClient: BatchedForgeClient,
    private auditLogger: AuditLogger,
    private negotiationRepo: PacketNegotiationRepository = new PacketNegotiationRepository(),
    private executionRepo: ExecutionRepository = new ExecutionRepository(),
    private packetRepo: InstructionPacketRepository = new InstructionPacketRepository(),
  ) {}

  async processBatch(batchExecutionId: string): Promise<void> {
    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: '',
      step: 'BATCH_PROCESSING',
      state: 'STARTED',
      status: 'IN_PROGRESS',
      message: 'Starting batch processing',
    });

    try {
      const batch = await this.batchRepo.findById(batchExecutionId);
      if (!batch) {
        throw new Error(`Batch execution ${batchExecutionId} not found`);
      }

      if (batch.current_state !== 'RECEIVED') {
        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: '',
          step: 'BATCH_PROCESSING',
          state: 'VALIDATION',
          status: 'SKIPPED',
          message: `Batch not in RECEIVED state: ${batch.current_state}`,
        });
        return;
      }

      await this.batchRepo.updateState(batchExecutionId, 'STORIES_RETRIEVING');
      const stories = await this.retrieveAllStories(batchExecutionId, batch.story_ids);

      await this.batchRepo.updateState(batchExecutionId, 'ARTIFACTS_RESOLVING');
      const projectContext = await this.fetchProjectContext(batch.project_key);

      await this.batchRepo.updateState(batchExecutionId, 'PACKET_PLANNING');
      const packetPlan = await this.generatePacketPlan(batchExecutionId, stories, projectContext);

      await this.batchRepo.updatePacketPlan(batchExecutionId, packetPlan);
      await this.batchRepo.updateState(batchExecutionId, 'PACKET_PLAN_APPROVED');

      await this.batchRepo.updateState(batchExecutionId, 'EXECUTING');
      await this.generateDIPsFromPlan(
        batchExecutionId,
        batch.epic_id,
        packetPlan,
        stories,
        projectContext,
      );

      await this.batchRepo.finalizeIfComplete(batchExecutionId);

      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: '',
        step: 'BATCH_PROCESSING',
        state: 'COMPLETED',
        status: 'success',
        message: 'Batch processing completed successfully',
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: '',
        step: 'BATCH_PROCESSING',
        state: 'FAILED',
        status: 'error',
        message: `Batch processing failed: ${error.message}`,
        metadata: { error: error.message },
      });
      await this.batchRepo.updateState(batchExecutionId, 'FAILED', error.message);
      throw error;
    }
  }

  private async retrieveAllStories(
    batchExecutionId: string,
    storyIds: string[],
  ): Promise<StoryPayload[]> {
    const stories: StoryPayload[] = [];
    for (const storyId of storyIds) {
      const story = await this.storyRetrieval.retrieveStory(storyId);
      stories.push(story);
    }

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: storyIds.join(','),
      step: 'STORY_RETRIEVAL',
      state: 'STORIES_FETCHED',
      status: 'success',
      message: `Retrieved ${stories.length} stories`,
      metadata: { storyCount: stories.length },
    });

    return stories;
  }

  // ORKY-74: Use getByProjectKey — never getAll()
  private async fetchProjectContext(projectKey: string): Promise<string> {
    try {
      const contextRepo = new ProjectContextRepository();
      const artifacts = await contextRepo.getByProjectKey(projectKey);
      if (artifacts.length === 0) return '_(No project context available)_';
      return artifacts
        .map((a) => `### ${a.artifactType.toUpperCase()}\n${a.content}`)
        .join('\n\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `_(Project context fetch failed: ${msg})_`;
    }
  }

  private async fetchImplementationHistory(epicId: string): Promise<string> {
    try {
      const decisionLogRepo = new DecisionLogRepository();
      const logs = await decisionLogRepo.getRecentByEpic(epicId, 5);
      if (logs.length === 0) return '_(No prior implementation history for this epic)_';
      return logs
        .map(
          (log) =>
            `**${log.storyId}** (${log.createdAt.toISOString().slice(0, 10)})\n` +
            `Files: ${log.filesChanged}\n` +
            `Patterns: ${log.patternsUsed}\n` +
            (log.migrationApplied ? `Migration: ${log.migrationApplied}\n` : '') +
            `Summary: ${log.summary}`,
        )
        .join('\n\n---\n\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `_(Implementation history fetch failed: ${msg})_`;
    }
  }

  private async generatePacketPlan(
    batchExecutionId: string,
    stories: StoryPayload[],
    projectContext: string,
  ): Promise<PacketPlan> {
    const packetPlan = await this.forgePlanner.generatePacketPlan(stories, projectContext);

    const allStoryIds = stories.map((s) => s.storyId).sort();
    const planStoryIds = packetPlan.packetPlan.flatMap((d) => d.storyIds).sort();

    if (JSON.stringify(allStoryIds) !== JSON.stringify(planStoryIds)) {
      throw new Error('Packet plan does not cover all stories exactly once');
    }

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: stories.map((s) => s.storyId).join(','),
      step: 'PACKET_PLANNING',
      state: 'PLAN_APPROVED',
      status: 'success',
      message: `Packet plan generated with ${packetPlan.packetPlan.length} DIPs`,
      metadata: { dipCount: packetPlan.packetPlan.length },
    });

    return packetPlan;
  }

  private async generateDIPsFromPlan(
    batchExecutionId: string,
    epicId: string,
    packetPlan: PacketPlan,
    allStories: StoryPayload[],
    projectContext: string,
  ): Promise<void> {
    const implementationHistory = await this.fetchImplementationHistory(epicId);
    const codebaseSnapshot = '_(No codebase snapshot available for batch DIP generation)_';

    for (const dipItem of packetPlan.packetPlan) {
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: dipItem.storyIds.join(','),
        step: 'DIP_GENERATION',
        state: 'DIP_GENERATING',
        status: 'IN_PROGRESS',
        message: `Generating DIP for ${dipItem.storyIds.length} stories: ${dipItem.storyIds.join(', ')}`,
        metadata: { dipRationale: dipItem.rationale, storyIds: dipItem.storyIds },
      });

      try {
        const dipStories = allStories.filter((s) => dipItem.storyIds.includes(s.storyId));

        if (dipStories.length !== dipItem.storyIds.length) {
          throw new Error(
            `Story count mismatch for DIP: expected ${dipItem.storyIds.length}, found ${dipStories.length}`,
          );
        }

        // ORKY-93: Generate initial DIP
        const dip = await this.batchedForgeClient.generateBatchedDIP({
          batchExecutionId,
          epicId,
          storyIds: dipItem.storyIds,
          stories: dipStories.map((s) => ({
            storyId: s.storyId,
            title: s.title,
            description: s.description,
            acceptanceCriteria: s.acceptanceCriteria,
            jiraIssueKey: s.jiraIssueKey,
          })),
          projectContext,
          implementationHistory,
          codebaseSnapshot,
        });

        // ORKY-93: Map BatchedDIP to InstructionPacket before negotiation.
        // Negotiator works on InstructionPacket — mapping must happen first.
        const initialPacket: InstructionPacket = {
          packetId: dip.packetId,
          storyId: dip.storyIds[0],
          targetRepository: dip.targetRepository,
          baseBranch: dip.baseBranch,
          branchNameHint: dip.branchNameHint,
          fileOperations: dip.fileOperations,
          validationCommands: dip.validationCommands,
          prTitle: dip.prTitle,
          prBody: dip.prBody,
          commitMessage: dip.commitMessage,
          implementationSummary: dip.implementationSummary,
          jiraLinkage: dip.jiraLinkage,
        };

        // ORKY-93: Create child execution record before negotiation so the
        // negotiator has a real executionId for state transitions and audit logs.
        const childExecution = await this.executionRepo.create({
          storyId: dip.storyIds.join(','),
          epicId,
          batchExecutionId,
          status: EXECUTION_STATES.RECEIVED as ExecutionState,
          currentState: EXECUTION_STATES.RECEIVED as ExecutionState,
        });

        await this.auditLogger.log({
          executionId: childExecution.executionId,
          storyId: dip.storyIds.join(','),
          step: 'CHILD_EXECUTION_CREATED',
          state: 'RECEIVED',
          status: 'success',
          message: `Child execution ${childExecution.executionId} created for DIP ${dip.packetId} (batch: ${batchExecutionId})`,
          metadata: { packetId: dip.packetId, batchExecutionId, storyIds: dip.storyIds },
        });

        // ORKY-93: Wire PacketNegotiationOrchestrator into batch path.
        // Follows the pattern in src/orchestrator/forgeOrchestrator.ts exactly.
        const reviewer = new PacketReviewer(this.auditLogger);
        const negotiationOrchestrator = new PacketNegotiationOrchestrator(
          reviewer,
          this.negotiationRepo,
          this.executionRepo,
          this.auditLogger,
        );

        const forgeRevise = async (
          issues: string[],
          currentPacket: InstructionPacket,
          contextFiles?: Record<string, string>,
        ): Promise<InstructionPacket> => {
          return this.batchedForgeClient.revise(
            childExecution.executionId,
            dip.storyIds.join(','),
            dipStories,
            issues,
            currentPacket,
            contextFiles,
          );
        };

        // Reuse snapshot files captured during generateBatchedDIP — no double fetch.
        const snapshotFiles = this.batchedForgeClient.getLastSnapshotFiles();

        const negotiationResult = await negotiationOrchestrator.negotiate(
          childExecution.executionId,
          dip.storyIds.join(','),
          initialPacket,
          codebaseSnapshot,
          forgeRevise,
          snapshotFiles,
        );

        if (!negotiationResult.approved) {
          // Negotiation exhausted or stalled — fail this child execution, continue to next DIP.
          await this.executionRepo.failIfNotTerminal(
            childExecution.executionId,
            negotiationResult.diagnosticMessage,
          );
          await this.auditLogger.log({
            executionId: childExecution.executionId,
            storyId: dip.storyIds.join(','),
            step: 'NEGOTIATION_FAILED',
            state: 'FAILED',
            status: 'error',
            message: `Negotiation failed for DIP ${dip.packetId}: ${negotiationResult.diagnosticMessage}`,
            metadata: { packetId: dip.packetId, storyIds: dip.storyIds },
          });
          continue;
        }

        const approvedPacket = negotiationResult.finalPacket;

        // ORKY-87: Persist approved DIP to instruction_packets immediately after negotiation
        // approval and before mutation agent handoff. Non-blocking — failed write logs warn only.
        try {
          await this.packetRepo.save(childExecution.executionId, approvedPacket);
        } catch (packetSaveErr: unknown) {
          const msg = packetSaveErr instanceof Error ? packetSaveErr.message : String(packetSaveErr);
          await this.auditLogger.log({
            executionId: childExecution.executionId,
            storyId: dip.storyIds.join(','),
            step: 'INSTRUCTION_PACKET_SAVE_FAILED',
            state: 'PACKET_VALIDATED',
            status: 'warn',
            message: `instruction_packets write failed (execution continues): ${msg}`,
          });
        }

        await this.persistDIP(
          batchExecutionId,
          epicId,
          dip,
          dipStories,
          childExecution.executionId,
          approvedPacket,
        );

        await this.auditLogger.log({
          executionId: childExecution.executionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'DIP_GENERATED',
          status: 'success',
          message: `DIP generated, negotiated, and executed successfully: ${dip.packetId}`,
          metadata: { packetId: dip.packetId, fileOperationCount: approvedPacket.fileOperations.length },
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'FAILED',
          status: 'error',
          message: `DIP generation/negotiation/execution failed for stories ${dipItem.storyIds.join(', ')}: ${error.message}`,
          metadata: { error: error.message, storyIds: dipItem.storyIds },
        });
      }
    }
  }

  // ORKY-93: persistDIP now receives the pre-created executionId and negotiation-approved
  // packet. Child execution creation and instruction_packets write happen in generateDIPsFromPlan.
  private async persistDIP(
    batchExecutionId: string,
    epicId: string,
    dip: BatchedDIP,
    dipStories: StoryPayload[],
    executionId: string,
    approvedPacket: InstructionPacket,
  ): Promise<void> {
    const primaryStory = dipStories[0];

    // Execute repository mutations (clones repo, applies file ops, stores change set)
    const mutationExecutor = new RepositoryMutationExecutor();
    await mutationExecutor.execute(
      executionId,
      dip.storyIds[0],
      approvedPacket,
      primaryStory?.projectKey ?? 'ORKY',
    );

    // Create branch, commit, PR, run CI gate, optional auto-merge
    const prOrchestrator = new PrOrchestrator();
    await prOrchestrator.run({
      executionId,
      storyId: dip.storyIds[0],
      storyTitle: primaryStory?.title ?? dip.storyIds.join(' + '),
      branchNameHint: approvedPacket.branchNameHint,
      targetRepository: approvedPacket.targetRepository,
      prTitle: approvedPacket.prTitle,
      prBody: approvedPacket.prBody,
      commitMessage: approvedPacket.commitMessage,
      projectKey: primaryStory?.projectKey ?? 'ORKY',
    });

    // ORKY-49: Post Jira success update for every story covered by this DIP
    try {
      const changeSetRepo = new RepoChangeSetRepository();
      const prData = await changeSetRepo.getPrDataByExecutionId(executionId);
      if (prData?.prUrl) {
        const jiraUpdater = new JiraUpdater(this.auditLogger);
        for (const dipStory of dipStories) {
          try {
            await jiraUpdater.reportSuccess({
              executionId,
              storyId: dipStory.storyId,
              issueKey: dipStory.jiraIssueKey,
              prUrl: prData.prUrl,
              mergeSha: prData.mergeSha ?? '',
            });
          } catch (jiraErr: unknown) {
            const msg = jiraErr instanceof Error ? jiraErr.message : String(jiraErr);
            await this.auditLogger.log({
              executionId,
              storyId: dipStory.storyId,
              step: 'JIRA_UPDATE_FAILED',
              state: 'COMPLETED',
              status: 'warn',
              message: `Jira update failed for ${dipStory.jiraIssueKey}: ${msg}`,
            });
          }
        }
      }
    } catch (prDataErr: unknown) {
      const msg = prDataErr instanceof Error ? prDataErr.message : String(prDataErr);
      await this.auditLogger.log({
        executionId,
        storyId: dip.storyIds.join(','),
        step: 'JIRA_UPDATE_SKIPPED',
        state: 'COMPLETED',
        status: 'warn',
        message: `Could not fetch PR data for Jira updates: ${msg}`,
      });
    }

    // ORKY-89: Write decision_log entry after each child execution completes.
    // Follows the exact pattern in src/orchestrator/executionFactory.ts.
    // Non-blocking — failed write logs warn and does not fail the execution.
    try {
      const changeSetRepo = new RepoChangeSetRepository();
      const changeSet = await changeSetRepo.getPrDataByExecutionId(executionId);
      const decisionLogRepo = new DecisionLogRepository();
      await decisionLogRepo.write({
        executionId,
        epicId: epicId ?? undefined,
        storyId: dip.storyIds.join(','),
        filesChanged: approvedPacket.fileOperations
          .map((op) => `${op.operation}: ${op.path}`)
          .join('\n'),
        patternsUsed: approvedPacket.implementationSummary,
        migrationApplied:
          approvedPacket.fileOperations
            .filter((op) => op.path.startsWith('migrations/'))
            .map((op) => op.path)
            .join(', ') || undefined,
        summary:
          `Stories: ${dip.storyIds.join(', ')}\n` +
          `PR: ${changeSet?.prUrl ?? 'unknown'}\n` +
          `Merge SHA: ${changeSet?.mergeSha ?? 'unknown'}\n` +
          `Files changed: ${approvedPacket.fileOperations.length}`,
      });
    } catch (decisionLogErr: unknown) {
      const msg = decisionLogErr instanceof Error ? decisionLogErr.message : String(decisionLogErr);
      await this.auditLogger.log({
        executionId,
        storyId: dip.storyIds.join(','),
        step: 'decision_log_write_failed',
        state: 'COMPLETED',
        status: 'warn',
        message: `Decision log write failed (execution still COMPLETED): ${msg}`,
      });
    }

    await this.batchRepo.finalizeIfComplete(batchExecutionId);
  }
}
