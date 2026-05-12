import { v4 as uuidv4 } from 'uuid';
import { BatchExecutionRepository } from '../db/repositories/batchExecutionRepository';
import { AuditLogger } from '../audit/auditLogger';

interface CollectionWindow {
  epicId: string;
  storyIds: string[];
  timer: NodeJS.Timeout;
  startedAt: Date;
}

export class BatchCollector {
  private windows: Map<string, CollectionWindow>;
  private collectionWindowMs: number;
  private batchExecutionRepository: BatchExecutionRepository;
  private auditLogger: AuditLogger;

  constructor(
    batchExecutionRepository: BatchExecutionRepository,
    auditLogger: AuditLogger
  ) {
    this.windows = new Map();
    this.collectionWindowMs = parseInt(
      process.env.BATCH_COLLECTION_WINDOW_MS || '60000',
      10
    );
    this.batchExecutionRepository = batchExecutionRepository;
    this.auditLogger = auditLogger;

    console.log(
      `BatchCollector initialized with window duration: ${this.collectionWindowMs}ms`
    );
  }

  async collectStory(
    storyId: string,
    epicId: string
  ): Promise<void> {
    const existingWindow = this.windows.get(epicId);

    if (existingWindow) {
      if (!existingWindow.storyIds.includes(storyId)) {
        existingWindow.storyIds.push(storyId);
        await this.auditLogger.log({
          executionId: null,
          storyId,
          step: 'batch_collection',
          state: 'STORY_ADDED_TO_WINDOW',
          status: 'success',
          message: `Story ${storyId} added to existing collection window for epic ${epicId}. Window now contains ${existingWindow.storyIds.length} stories.`,
          metadataJson: JSON.stringify({
            epicId,
            windowStoryCount: existingWindow.storyIds.length,
            windowStartedAt: existingWindow.startedAt.toISOString()
          }),
          timestamp: new Date()
        });
        console.log(
          `Story ${storyId} added to existing window for epic ${epicId}. Total stories: ${existingWindow.storyIds.length}`
        );
      } else {
        await this.auditLogger.log({
          executionId: null,
          storyId,
          step: 'batch_collection',
          state: 'STORY_DUPLICATE_IGNORED',
          status: 'success',
          message: `Story ${storyId} already in collection window for epic ${epicId}. Duplicate webhook ignored.`,
          metadataJson: JSON.stringify({ epicId }),
          timestamp: new Date()
        });
        console.log(
          `Story ${storyId} already in window for epic ${epicId}. Ignoring duplicate.`
        );
      }
    } else {
      const startedAt = new Date();
      const timer = setTimeout(() => {
        this.closeWindow(epicId).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `Failed to close collection window for epic ${epicId}:`,
            message
          );
        });
      }, this.collectionWindowMs);

      this.windows.set(epicId, {
        epicId,
        storyIds: [storyId],
        timer,
        startedAt
      });

      await this.auditLogger.log({
        executionId: null,
        storyId,
        step: 'batch_collection',
        state: 'WINDOW_STARTED',
        status: 'success',
        message: `Collection window started for epic ${epicId}. Initial story: ${storyId}. Window will close in ${this.collectionWindowMs}ms.`,
        metadataJson: JSON.stringify({
          epicId,
          windowDurationMs: this.collectionWindowMs,
          windowStartedAt: startedAt.toISOString()
        }),
        timestamp: new Date()
      });
      console.log(
        `Collection window started for epic ${epicId} with story ${storyId}. Closes in ${this.collectionWindowMs}ms.`
      );
    }
  }

  private async closeWindow(epicId: string): Promise<void> {
    const window = this.windows.get(epicId);
    if (!window) {
      console.log(`No window found for epic ${epicId}. Already closed.`);
      return;
    }

    clearTimeout(window.timer);
    this.windows.delete(epicId);

    const batchExecutionId = uuidv4();
    const closedAt = new Date();

    await this.batchExecutionRepository.create({
      batchExecutionId,
      epicId,
      storyIds: window.storyIds,
      status: 'COLLECTED',
      startedAt: window.startedAt,
      collectedAt: closedAt
    });

    await this.auditLogger.log({
      executionId: batchExecutionId,
      storyId: null,
      step: 'batch_collection',
      state: 'WINDOW_CLOSED',
      status: 'success',
      message: `Collection window closed for epic ${epicId}. Collected ${window.storyIds.length} stories. Batch execution created: ${batchExecutionId}.`,
      metadataJson: JSON.stringify({
        epicId,
        batchExecutionId,
        storyIds: window.storyIds,
        storyCount: window.storyIds.length,
        windowStartedAt: window.startedAt.toISOString(),
        windowClosedAt: closedAt.toISOString()
      }),
      timestamp: new Date()
    });
    console.log(
      `Collection window closed for epic ${epicId}. Batch execution ${batchExecutionId} created with ${window.storyIds.length} stories: ${window.storyIds.join(', ')}`
    );

    // Trigger packet planning (integration point for STORY-11.3)
    console.log(
      `Ready to invoke Packet Planning for batch execution ${batchExecutionId}.`
    );
  }

  async shutdown(): Promise<void> {
    console.log('BatchCollector shutting down. Closing all open windows...');
    const epicIds = Array.from(this.windows.keys());
    for (const epicId of epicIds) {
      await this.closeWindow(epicId);
    }
    console.log('All collection windows closed.');
  }
}
