import { AuditLogger } from '../audit/auditLogger';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { JiraStoryRetrievalService } from '../integrations/jira/jiraStoryRetrievalService';
import { ForgePlannerClient, PacketPlan } from '../integrations/forge/forgePlannerClient';
import { BatchedForgeClient, BatchedDIP } from '../integrations/forge/batchedForgeClient';
import { ProjectContextRepository } from '../db/repositories/projectContextRepository';
import { ImplementationHistoryRepository } from '../db/repositories/implementationHistoryRepository';

export class BatchOrchestrator {
  constructor(
    private batchRepo: BatchExecutionRepository,
    private executionRepo: ExecutionRepository,
    private auditLogger: AuditLogger,
    private jiraRetrieval: JiraStoryRetrievalService,
    private forgePlanner: ForgePlannerClient,
    private batchedForgeClient: BatchedForgeClient,
    private projectContextRepo: ProjectContextRepository,
    private implementationHistoryRepo: ImplementationHistoryRepository
  ) {}

  async processBatch(batchExecutionId: string): Promise<void> {
    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: '',
      step: 'BATCH_PROCESSING',
      state: 'STARTED',
      status: 'IN_PROGRESS',
      message: 'Starting batch processing'
    });

    try {
      const batch = await this.batchRepo.getById(batchExecutionId);
      if (!batch) {
        throw new Error(`Batch execution ${batchExecutionId} not found`);
      }

      if (batch.status !== 'COLLECTED') {
        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: '',
          step: 'BATCH_PROCESSING',
          state: 'VALIDATION',
          status: 'SKIPPED',
          message: `Batch not in COLLECTED status: ${batch.status}`
        });
        return;
      }

      await this.batchRepo.updateStatus(batchExecutionId, 'STORIES_FETCHED');

      const stories = await this.retrieveAllStories(batchExecutionId, batch.story_ids);

      await this.batchRepo.updateStatus(batchExecutionId, 'PLANNING');

      const packetPlan = await this.generatePacketPlan(batchExecutionId, batch.epic_id, stories);

      await this.batchRepo.updatePacketPlan(batchExecutionId, packetPlan);
      await this.batchRepo.updateStatus(batchExecutionId, 'PLAN_APPROVED');

      await this.generateDIPsFromPlan(batchExecutionId, batch.epic_id, packetPlan, stories);

      await this.batchRepo.updateStatus(batchExecutionId, 'DIPS_GENERATED');

      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: '',
        step: 'BATCH_PROCESSING',
        state: 'COMPLETED',
        status: 'SUCCESS',
        message: 'Batch processing completed successfully'
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: '',
        step: 'BATCH_PROCESSING',
        state: 'FAILED',
        status: 'FAILED',
        message: `Batch processing failed: ${error.message}`,
        metadata: { error: error.message }
      });
      await this.batchRepo.updateStatus(batchExecutionId, 'FAILED');
      throw error;
    }
  }

  private async retrieveAllStories(
    batchExecutionId: string,
    storyIds: string[]
  ): Promise<Array<{ storyId: string; title: string; description: string; acceptanceCriteria: string; jiraIssueKey: string }>> {
    const stories = [];
    for (const storyId of storyIds) {
      const execution = await this.executionRepo.getById(storyId);
      if (!execution) {
        throw new Error(`Execution ${storyId} not found`);
      }
      const story = await this.jiraRetrieval.retrieveStory(execution.jira_issue_key);
      stories.push(story);
    }

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: storyIds.join(','),
      step: 'STORY_RETRIEVAL',
      state: 'STORIES_FETCHED',
      status: 'SUCCESS',
      message: `Retrieved ${stories.length} stories`,
      metadata: { storyCount: stories.length }
    });

    return stories;
  }

  private async generatePacketPlan(
    batchExecutionId: string,
    epicId: string,
    stories: Array<{ storyId: string; title: string; description: string; acceptanceCriteria: string; jiraIssueKey: string }>
  ): Promise<PacketPlan> {
    const plan = await this.forgePlanner.generatePacketPlan({
      batchExecutionId,
      epicId,
      stories
    });

    const allStoryIds = stories.map(s => s.storyId).sort();
    const planStoryIds = plan.dips.flatMap(d => d.storyIds).sort();

    if (JSON.stringify(allStoryIds) !== JSON.stringify(planStoryIds)) {
      throw new Error('Packet plan does not cover all stories exactly once');
    }

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: '',
      step: 'PACKET_PLANNING',
      state: 'PLAN_APPROVED',
      status: 'SUCCESS',
      message: `Packet plan generated with ${plan.dips.length} DIPs`,
      metadata: { dipCount: plan.dips.length, plan }
    });

    return plan;
  }

  private async generateDIPsFromPlan(
    batchExecutionId: string,
    epicId: string,
    packetPlan: PacketPlan,
    allStories: Array<{ storyId: string; title: string; description: string; acceptanceCriteria: string; jiraIssueKey: string }>
  ): Promise<void> {
    const pdeArtifacts = await this.projectContextRepo.getAll();
    const implementationHistory = await this.implementationHistoryRepo.getRecent(5);
    const codebaseSnapshot = '_(No codebase snapshot available for batch DIP generation)_';

    for (const dipItem of packetPlan.dips) {
      await this.auditLogger.log({
        executionId: batchExecutionId,
        storyId: dipItem.storyIds.join(','),
        step: 'DIP_GENERATION',
        state: 'DIP_GENERATING',
        status: 'IN_PROGRESS',
        message: `Generating DIP for ${dipItem.storyIds.length} stories: ${dipItem.storyIds.join(', ')}`,
        metadata: { dipRationale: dipItem.rationale, storyIds: dipItem.storyIds }
      });

      try {
        const dipStories = allStories.filter(s => dipItem.storyIds.includes(s.storyId));

        if (dipStories.length !== dipItem.storyIds.length) {
          throw new Error(`Story count mismatch for DIP: expected ${dipItem.storyIds.length}, found ${dipStories.length}`);
        }

        const dip = await this.batchedForgeClient.generateBatchedDIP({
          batchExecutionId,
          epicId,
          storyIds: dipItem.storyIds,
          stories: dipStories,
          baPack: pdeArtifacts.baPack || '',
          developerExecutionPacket: pdeArtifacts.developerExecutionPacket || '',
          engineeringSpec: pdeArtifacts.engineeringSpec || '',
          manifest: pdeArtifacts.manifest || '',
          productDesignDocument: pdeArtifacts.productDesignDocument || '',
          productIntentBrief: pdeArtifacts.productIntentBrief || '',
          qaPacket: pdeArtifacts.qaPacket || '',
          systemArch: pdeArtifacts.systemArch || '',
          implementationHistory: implementationHistory || '',
          codebaseSnapshot
        });

        await this.persistDIP(batchExecutionId, dip);

        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'DIP_GENERATED',
          status: 'SUCCESS',
          message: `DIP generated successfully: ${dip.packetId}`,
          metadata: { packetId: dip.packetId, fileOperationCount: dip.fileOperations.length }
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        await this.auditLogger.log({
          executionId: batchExecutionId,
          storyId: dipItem.storyIds.join(','),
          step: 'DIP_GENERATION',
          state: 'FAILED',
          status: 'FAILED',
          message: `DIP generation failed: ${error.message}`,
          metadata: { error: error.message }
        });

        for (const storyId of dipItem.storyIds) {
          await this.executionRepo.updateState(storyId, 'FAILED');
          await this.executionRepo.updateFailureReason(
            storyId,
            `Batched DIP generation failed: ${error.message}`
          );
        }
      }
    }
  }

  private async persistDIP(batchExecutionId: string, dip: BatchedDIP): Promise<void> {
    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: dip.storyIds.join(','),
      step: 'DIP_PERSISTENCE',
      state: 'PERSISTING',
      status: 'IN_PROGRESS',
      message: `Persisting DIP ${dip.packetId}`
    });

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: dip.storyIds.join(','),
      step: 'DIP_PERSISTENCE',
      state: 'PERSISTED',
      status: 'SUCCESS',
      message: `DIP persisted: ${dip.packetId}`,
      metadata: { packetId: dip.packetId, storyIds: dip.storyIds }
    });
  }
}
