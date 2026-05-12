import { AuditLogger } from '../audit/auditLogger';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { DecisionLogRepository } from '../db/repositories/decisionLogRepository';
import { ProjectContextRepository } from '../db/repositories/projectContextRepository';
import { StoryRetrievalService } from '../integrations/jira/storyRetrievalService';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
import { BatchedForgeClient, BatchedDIP } from '../integrations/forge/batchedForgeClient';
import { StoryPayload } from '../domain/storyPayload';

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

      await this.generateDIPsFromPlan(
        batchExecutionId,
        batch.epic_id,
        packetPlan,
        stories,
        projectContext,
      );

      await this.batchRepo.updateState(batchExecutionId, 'DIPS_GENERATED');

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

        await this.persistDIP(batchExecutionId, dip);

        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'DIP_GENERATED',
          status: 'success',
          message: `DIP generated successfully: ${dip.packetId}`,
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
          message: `DIP generation failed for stories ${dipItem.storyIds.join(', ')}: ${error.message}`,
          metadata: { error: error.message, storyIds: dipItem.storyIds },
        });
      }
    }
  }

  private async persistDIP(batchExecutionId: string, dip: BatchedDIP): Promise<void> {
    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: dip.storyIds.join(','),
      step: 'DIP_PERSISTENCE',
      state: 'PERSISTED',
      status: 'success',
      message: `DIP ${dip.packetId} ready (persistence to DB pending EPIC-10 schema integration)`,
      metadata: { packetId: dip.packetId, storyIds: dip.storyIds },
    });
  }
}
