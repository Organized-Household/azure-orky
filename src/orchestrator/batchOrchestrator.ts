import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { StoryRetrievalService } from '../integrations/jira/storyRetrievalService';
import { ProjectContextRepository } from '../db/repositories/projectContextRepository';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
import { StoryPayload } from '../domain/storyPayload';
import { AuditLogger } from '../audit/auditLogger';

export class BatchOrchestrator {
  constructor(
    private batchRepo: BatchExecutionRepository,
    private storyRetrieval: StoryRetrievalService,
    private forgePlanner: ForgePlannerClient,
    private auditLogger: AuditLogger,
  ) {}

  async executeBatch(batchExecutionId: string): Promise<void> {
    console.log(`[BatchOrchestrator] Starting batch execution: ${batchExecutionId}`);

    const batch = await this.batchRepo.findById(batchExecutionId);
    if (!batch) {
      throw new Error(`Batch execution not found: ${batchExecutionId}`);
    }

    try {
      await this.transitionState(batchExecutionId, 'STORIES_RETRIEVING');
      const stories = await this.retrieveAllStories(batch.story_ids);

      await this.transitionState(batchExecutionId, 'ARTIFACTS_RESOLVING');
      const projectContext = await this.fetchProjectContext();

      await this.transitionState(batchExecutionId, 'PACKET_PLANNING');
      const packetPlan = await this.generatePacketPlan(
        batchExecutionId,
        stories,
        projectContext,
      );

      await this.batchRepo.updatePacketPlan(batchExecutionId, packetPlan);
      await this.transitionState(batchExecutionId, 'PACKET_PLAN_APPROVED');

      console.log(`[BatchOrchestrator] Batch ${batchExecutionId} packet planning completed`);
    } catch (err: unknown) {
      const failureReason = err instanceof Error ? err.message : 'Unknown failure';
      await this.batchRepo.updateState(batchExecutionId, 'FAILED', failureReason);
      console.error(`[BatchOrchestrator] Batch ${batchExecutionId} failed: ${failureReason}`);
      throw err;
    }
  }

  private async retrieveAllStories(storyIds: string[]): Promise<StoryPayload[]> {
    const stories: StoryPayload[] = [];
    for (const storyId of storyIds) {
      const story = await this.storyRetrieval.retrieveStory(storyId);
      stories.push(story);
    }
    console.log(`[BatchOrchestrator] Retrieved ${stories.length} stories`);
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

  private async generatePacketPlan(
    batchExecutionId: string,
    stories: StoryPayload[],
    projectContext: string,
  ): Promise<PacketPlan> {
    try {
      const packetPlan = await this.forgePlanner.generatePacketPlan(stories, projectContext);

      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: stories.map((s) => s.storyId).join(','),
        step: 'packet_plan_generated',
        state: 'PACKET_PLANNING',
        status: 'success',
        message: `Packet plan generated with ${packetPlan.packetPlan.length} DIPs`,
        metadata: { dipCount: packetPlan.packetPlan.length },
      });

      return packetPlan;
    } catch (err: unknown) {
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: stories.map((s) => s.storyId).join(','),
        step: 'packet_plan_failed',
        state: 'PACKET_PLANNING',
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown packet planning error',
      });
      throw err;
    }
  }

  private async transitionState(batchExecutionId: string, newState: string): Promise<void> {
    await this.batchRepo.updateState(batchExecutionId, newState);
    console.log(`[BatchOrchestrator] Batch ${batchExecutionId} -> ${newState}`);
  }
}
