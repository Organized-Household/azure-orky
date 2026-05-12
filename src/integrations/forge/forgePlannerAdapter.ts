import { getEnv } from '../../config/env';
import { ForgePlannerClient, ForgePlanningRequest, PacketPlan } from './forgePlannerClient';
import { logger } from '../../utils/logger';

export class ForgePlannerAdapter {
  private readonly client: ForgePlannerClient;

  constructor() {
    const env = getEnv();
    this.client = new ForgePlannerClient({
      url: env.FORGE_API_URL,
      apiKey: env.FORGE_API_KEY,
      model: env.FORGE_MODEL,
      maxTokens: env.FORGE_MAX_TOKENS,
      timeoutMs: env.FORGE_TIMEOUT_MS
    });
  }

  async generatePacketPlan(request: ForgePlanningRequest): Promise<PacketPlan> {
    logger.info('ForgePlannerAdapter: Generating Packet Plan', {
      epicId: request.epicId,
      storyCount: request.stories.length
    });

    try {
      const plan = await this.client.requestPacketPlan(request);

      logger.info('ForgePlannerAdapter: Packet Plan generated successfully', {
        dipCount: plan.packetPlan.length
      });

      return plan;
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error('ForgePlannerAdapter: Packet Plan generation failed', {
          error: err.message,
          epicId: request.epicId
        });
        throw new Error(`Packet Plan generation failed: ${err.message}`);
      }
      throw new Error('Packet Plan generation failed: unknown error');
    }
  }
}
