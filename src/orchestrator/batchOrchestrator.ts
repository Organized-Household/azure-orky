import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { StoryRetrievalService } from '../integrations/jira/storyRetrievalService';
import { ArtifactResolver } from '../artifacts/artifactResolver';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
import { StoryPayload } from '../domain/storyPayload';
import { AuditLogger } from '../audit/auditLogger';

export class BatchOrchestrator {
  private batchRepo: BatchExecutionRepository;
  private storyRetrieval: StoryRetrievalService;
  private artifactResolver: ArtifactResolver;
  private forgePlanner: ForgePlannerClient;
  private auditLogger: AuditLogger;

  constructor(
    batchRepo: BatchExecutionRepository,
    storyRetrieval: StoryRetrievalService,
    artifactResolver: ArtifactResolver,
    forgePlanner: ForgePlannerClient,
    auditLogger: AuditLogger
  ) {
    this.batchRepo = batchRepo;
    this.storyRetrieval = storyRetrieval;
    this.artifactResolver = artifactResolver;
    this.forgePlanner = forgePlanner;
    this.auditLogger = auditLogger;
  }

  async executeBatch(batchExecutionId: string): Promise<void> {
    console.log(`[BatchOrchestrator] Starting batch execution: ${batchExecutionId}`);

    const batch = await this.batchRepo.findById(batchExecutionId);
    if (!batch) {
      throw new Error(`Batch execution not found: ${batchExecutionId}`);
    }

    try {
      await this.transitionState(batchExecutionId, 'STORIES_RETRIEVING', 'IN_PROGRESS');
      const stories = await this.retrieveAllStories(batch.story_ids);

      await this.transitionState(batchExecutionId, 'ARTIFACTS_RESOLVING', 'IN_PROGRESS');
      const artifacts = await this.artifactResolver.resolve(batch.epic_id);

      await this.transitionState(batchExecutionId, 'PACKET_PLANNING', 'IN_PROGRESS');
      const packetPlan = await this.generatePacketPlan(batchExecutionId, stories, artifacts);

      await this.batchRepo.updatePacketPlan(batchExecutionId, packetPlan);
      await this.transitionState(batchExecutionId, 'PACKET_PLAN_APPROVED', 'IN_PROGRESS');

      console.log(`[BatchOrchestrator] Batch ${batchExecutionId} packet planning completed successfully`);
    } catch (err: unknown) {
      await this.handleFailure(batchExecutionId, err);
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

  private async generatePacketPlan(
    batchExecutionId: string,
    stories: StoryPayload[],
    artifacts: { baPack: string; pdd: string; systemArch: string }
  ): Promise<PacketPlan> {
    try {
      const packetPlan = await this.forgePlanner.generatePacketPlan(stories, artifacts);

      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: stories.map((s) => s.storyId).join(','),
        step: 'PACKET_PLANNING',
        state: 'PACKET_PLANNING',
        status: 'SUCCESS',
        message: `Packet plan generated with ${packetPlan.packetPlan.length} DIPs`,
        metadata: { dipCount: packetPlan.packetPlan.length }
      });

      return packetPlan;
    } catch (err: unknown) {
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: stories.map((s) => s.storyId).join(','),
        step: 'PACKET_PLANNING',
        state: 'PACKET_PLANNING',
        status: 'FAILED',
        message: err instanceof Error ? err.message : 'Unknown packet planning error',
        metadata: {}
      });
      throw err;
    }
  }

  private async transitionState(
    batchExecutionId: string,
    newState: string,
    status: string
  ): Promise<void> {
    await this.batchRepo.updateState(batchExecutionId, newState, status);
    console.log(`[BatchOrchestrator] Batch ${batchExecutionId} -> ${newState}`);
  }

  private async handleFailure(batchExecutionId: string, err: unknown): Promise<void> {
    const failureReason = err instanceof Error ? err.message : 'Unknown failure';
    await this.batchRepo.updateState(batchExecutionId, 'FAILED', 'FAILED', failureReason);
    console.error(`[BatchOrchestrator] Batch ${batchExecutionId} failed: ${failureReason}`);
  }
}
