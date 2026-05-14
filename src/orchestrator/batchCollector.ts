import { v4 as uuidv4 } from 'uuid';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { AuditLogger } from '../audit/auditLogger';
import { BatchOrchestrator } from './batchOrchestrator';
import { StoryRetrievalService } from '../integrations/jira/storyRetrievalService';
import { ForgePlannerClient } from '../integrations/forge/forgePlannerClient';
import { BatchedForgeClient } from '../integrations/forge/batchedForgeClient';

interface CollectionWindow {
  epicId: string;
  projectKey: string;
  storyIds: string[];
  timer: NodeJS.Timeout;
  startedAt: Date;
}

export class BatchCollector {
  private windows: Map<string, CollectionWindow>;
  private readonly collectionWindowMs: number;

  constructor(
    private batchExecutionRepository: BatchExecutionRepository,
    private auditLogger: AuditLogger,
  ) {
    this.windows = new Map();
    this.collectionWindowMs = parseInt(process.env.BATCH_COLLECTION_WINDOW_MS || '60000', 10);
    console.log(`[BatchCollector] Initialized with window duration: ${this.collectionWindowMs}ms`);
  }

  async collectStory(storyId: string, epicId: string, projectKey: string): Promise<void> {
    console.log(`[BatchCollector] collectStory called — storyId: ${storyId}, epicId: "${epicId}", projectKey: ${projectKey}`);
    const existingWindow = this.windows.get(epicId);

    if (existingWindow) {
      if (!existingWindow.storyIds.includes(storyId)) {
        existingWindow.storyIds.push(storyId);
        await this.auditLogger.log({
          executionId: '',
          storyId,
          step: 'batch_collection',
          state: 'STORY_ADDED_TO_WINDOW',
          status: 'success',
          message: `Story ${storyId} added to existing collection window for epic ${epicId}. Window now contains ${existingWindow.storyIds.length} stories.`,
          metadata: {
            epicId,
            windowStoryCount: existingWindow.storyIds.length,
            windowStartedAt: existingWindow.startedAt.toISOString(),
          },
        });
        console.log(`[BatchCollector] Story ${storyId} added to window for epic ${epicId}. Total: ${existingWindow.storyIds.length}`);
      } else {
        await this.auditLogger.log({
          executionId: '',
          storyId,
          step: 'batch_collection',
          state: 'STORY_DUPLICATE_IGNORED',
          status: 'success',
          message: `Story ${storyId} already in collection window for epic ${epicId}. Duplicate webhook ignored.`,
          metadata: { epicId },
        });
        console.log(`[BatchCollector] Story ${storyId} already in window for epic ${epicId}. Ignoring duplicate.`);
      }
    } else {
      const startedAt = new Date();
      const timer = setTimeout(() => {
        this.closeWindow(epicId).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[BatchCollector] Failed to close window for epic ${epicId}: ${message}`);
        });
      }, this.collectionWindowMs);

      this.windows.set(epicId, { epicId, projectKey, storyIds: [storyId], timer, startedAt });

      await this.auditLogger.log({
        executionId: '',
        storyId,
        step: 'batch_collection',
        state: 'WINDOW_STARTED',
        status: 'success',
        message: `Collection window started for epic ${epicId}. Initial story: ${storyId}. Window will close in ${this.collectionWindowMs}ms.`,
        metadata: {
          epicId,
          windowDurationMs: this.collectionWindowMs,
          windowStartedAt: startedAt.toISOString(),
        },
      });
      console.log(`[BatchCollector] Collection window started for epic ${epicId} with story ${storyId}. Closes in ${this.collectionWindowMs}ms.`);
    }
  }

  private async closeWindow(epicId: string): Promise<void> {
    const window = this.windows.get(epicId);
    if (!window) {
      console.log(`[BatchCollector] No window found for epic ${epicId}. Already closed.`);
      return;
    }

    clearTimeout(window.timer);
    this.windows.delete(epicId);

    const batchExecutionId = uuidv4();

    await this.batchExecutionRepository.create(
      batchExecutionId,
      window.epicId,
      window.projectKey,
      window.storyIds,
      window.startedAt,
    );

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: '',
      step: 'batch_collection',
      state: 'WINDOW_CLOSED',
      status: 'success',
      message: `Collection window closed for epic ${epicId}. Collected ${window.storyIds.length} stories. Batch execution created: ${batchExecutionId}.`,
      metadata: {
        epicId,
        batchExecutionId,
        storyIds: window.storyIds,
        storyCount: window.storyIds.length,
        windowStartedAt: window.startedAt.toISOString(),
      },
    });
    console.log(`[BatchCollector] Window closed for epic ${epicId}. Batch ${batchExecutionId} created with ${window.storyIds.length} stories.`);

    // Fire-and-forget: batch processing runs asynchronously in the background
    const batchOrchestrator = new BatchOrchestrator(
      this.batchExecutionRepository,
      new StoryRetrievalService(),
      new ForgePlannerClient(),
      new BatchedForgeClient(this.auditLogger),
      this.auditLogger,
    );
    batchOrchestrator.processBatch(batchExecutionId).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[BatchCollector] Batch processing failed for ${batchExecutionId}: ${message}`);
    });
  }

  async shutdown(): Promise<void> {
    console.log('[BatchCollector] Shutting down. Closing all open windows...');
    const epicIds = Array.from(this.windows.keys());
    for (const epicId of epicIds) {
      await this.closeWindow(epicId);
    }
    console.log('[BatchCollector] All collection windows closed.');
  }
}
