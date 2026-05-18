import { AuditLogger } from '../audit/auditLogger';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { DecisionLogRepository } from '../db/repositories/decisionLogRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { ProjectContextRepository } from '../db/repositories/projectContextRepository';
import { RepoChangeSetRepository } from '../db/repositories/repoChangeSetRepository';
import { InstructionPacket } from '../domain/instructionPacket';
import { EXECUTION_STATES, ExecutionState, StoryPayload } from '../domain/storyPayload';
import { RepositoryMutationExecutor } from '../agents/repositoryMutationExecutor';
import { BatchedForgeClient, BatchedDIP } from '../integrations/forge/batchedForgeClient';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
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
      const projectContext = await this.fetchProjectContext();

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

      // Finalize batch state based on child execution outcomes
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

  private async fetchProjectContext(): Promise<string> {
    try {
      const contextRepo = new ProjectContextRepository();
      const artifacts = await contextRepo.getAll();
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

        await this.persistDIP(batchExecutionId, epicId, dip, dipStories);

        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'DIP_GENERATED',
          status: 'success',
          message: `DIP generated and executed successfully: ${dip.packetId}`,
          metadata: { packetId: dip.packetId, fileOperationCount: dip.fileOperations.length },
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'FAILED',
          status: 'error',
          message: `DIP generation/execution failed for stories ${dipItem.storyIds.join(', ')}: ${error.message}`,
          metadata: { error: error.message, storyIds: dipItem.storyIds },
        });
      }
    }
  }

  private async persistDIP(
    batchExecutionId: string,
    epicId: string,
    dip: BatchedDIP,
    dipStories: StoryPayload[],
  ): Promise<void> {
    const executionRepo = new ExecutionRepository();
    const primaryStory = dipStories[0];

    // Create child execution record linked to this batch
    const execution = await executionRepo.create({
      storyId: dip.storyIds.join(','),
      epicId,
      batchExecutionId,
      status: EXECUTION_STATES.RECEIVED as ExecutionState,
      currentState: EXECUTION_STATES.RECEIVED as ExecutionState,
    });

    await this.auditLogger.log({
      executionId: execution.executionId,
      storyId: dip.storyIds.join(','),
      step: 'CHILD_EXECUTION_CREATED',
      state: 'RECEIVED',
      status: 'success',
      message: `Child execution ${execution.executionId} created for DIP ${dip.packetId} (batch: ${batchExecutionId})`,
      metadata: { packetId: dip.packetId, batchExecutionId, storyIds: dip.storyIds },
    });

    // Build InstructionPacket from BatchedDIP
    const packet: InstructionPacket = {
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

    // Execute repository mutations (clones repo, applies file ops, stores change set)
    const mutationExecutor = new RepositoryMutationExecutor();
    await mutationExecutor.execute(execution.executionId, dip.storyIds[0], packet, primaryStory?.projectKey ?? 'ORKY');

    // Create branch, commit, PR, run CI gate, optional auto-merge
    const prOrchestrator = new PrOrchestrator();
    await prOrchestrator.run({
      executionId: execution.executionId,
      storyId: dip.storyIds[0],
      storyTitle: primaryStory?.title ?? dip.storyIds.join(' + '),
      branchNameHint: dip.branchNameHint,
      targetRepository: dip.targetRepository,
      prTitle: dip.prTitle,
      prBody: dip.prBody,
      commitMessage: dip.commitMessage,
      projectKey: primaryStory?.projectKey ?? 'ORKY',
    });

    // ORKY-49: Post Jira success update for every story covered by this DIP
    try {
      const changeSetRepo = new RepoChangeSetRepository();
      const prData = await changeSetRepo.getPrDataByExecutionId(execution.executionId);
      if (prData?.prUrl) {
        const jiraUpdater = new JiraUpdater(this.auditLogger);
        for (const dipStory of dipStories) {
          try {
            await jiraUpdater.reportSuccess({
              executionId: execution.executionId,
              storyId: dipStory.storyId,
              issueKey: dipStory.jiraIssueKey,
              prUrl: prData.prUrl,
              mergeSha: prData.mergeSha ?? '',
            });
          } catch (jiraErr: unknown) {
            const msg = jiraErr instanceof Error ? jiraErr.message : String(jiraErr);
            await this.auditLogger.log({
              executionId: execution.executionId,
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
        executionId: execution.executionId,
        storyId: dip.storyIds.join(','),
        step: 'JIRA_UPDATE_SKIPPED',
        state: 'COMPLETED',
        status: 'warn',
        message: `Could not fetch PR data for Jira updates: ${msg}`,
      });
    }

    // Check if all child executions for this batch are now terminal
    await this.batchRepo.finalizeIfComplete(batchExecutionId);
  }
}
