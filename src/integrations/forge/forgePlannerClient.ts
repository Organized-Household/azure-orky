import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../observability/logger';
import { StoryPayload } from '../../domain/storyPayload';

export interface PacketPlanDIP {
  dipId: string;
  storyIds: string[];
  rationale: string;
}

export interface PacketPlan {
  packetPlan: PacketPlanDIP[];
}

export interface ForgePlannerResult {
  success: boolean;
  packetPlan?: PacketPlan;
  error?: string;
}

export class ForgePlannerClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(
    apiKey: string,
    model: string = 'claude-3-7-sonnet-20250219',
    maxTokens: number = 16000,
    temperature: number = 0
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async planPackets(
    stories: StoryPayload[],
    baPack: string,
    systemArch: string,
    pdd: string
  ): Promise<ForgePlannerResult> {
    try {
      const prompt = this.buildPlanningPrompt(stories, baPack, systemArch, pdd);

      logger.info('Invoking Forge for Packet Planning', {
        storyCount: stories.length,
        storyIds: stories.map(s => s.storyId),
        model: this.model
      });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const textContent = response.content.find(block => block.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return {
          success: false,
          error: 'Forge response contained no text content'
        };
      }

      const rawText = textContent.text.trim();
      const packetPlan = this.parsePacketPlan(rawText);

      if (!packetPlan) {
        return {
          success: false,
          error: 'Failed to parse valid JSON Packet Plan from Forge response'
        };
      }

      const validationError = this.validatePacketPlan(packetPlan, stories);
      if (validationError) {
        return {
          success: false,
          error: validationError
        };
      }

      logger.info('Forge Packet Plan validated successfully', {
        dipCount: packetPlan.packetPlan.length
      });

      return {
        success: true,
        packetPlan
      };
    } catch (err: unknown) {
      logger.error('Forge Packet Planning failed', { err });
      if (err instanceof Error) {
        return {
          success: false,
          error: err.message
        };
      }
      return {
        success: false,
        error: 'Unknown error during Forge Packet Planning'
      };
    }
  }

  private buildPlanningPrompt(
    stories: StoryPayload[],
    baPack: string,
    systemArch: string,
    pdd: string
  ): string {
    const storyListJson = JSON.stringify(
      stories.map(s => ({
        storyId: s.storyId,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria
      })),
      null,
      2
    );

    return `You are Forge, Senior SaaS Engineer responsible for planning Developer Instruction Packets (DIPs) for batched Jira story execution.

You have been given a batch of stories from the same epic that are all marked Ready for Engineering. Your task is to produce a Packet Plan that decides how many DIPs to generate and which stories belong in each DIP.

## Planning Rules

1. **Group stories with no file overlap**: Stories that create or modify completely different files can safely be batched into a single DIP.
2. **Separate stories that touch the same files**: If two stories modify the same file, they MUST be in separate DIPs to avoid merge conflicts.
3. **Respect sequential dependencies**: If one story logically depends on another (e.g., Story B uses infrastructure created by Story A), Story A must be in an earlier DIP than Story B.
4. **Every story must appear exactly once**: No story may be omitted. No story may appear in multiple DIPs.
5. **Provide clear rationale**: For each DIP, explain why those stories were grouped together or kept separate.

## Context Artifacts

### BA Pack
${baPack}

### System Architecture
${systemArch}

### Product Design Document
${pdd}

## Stories to Plan

${storyListJson}

## Required Output

Return ONLY a single valid JSON object matching this schema:

{
  "packetPlan": [
    {
      "dipId": "dip-1",
      "storyIds": ["ORKY-36", "ORKY-37"],
      "rationale": "Stories 9.1 and 9.2 both add new tables and repositories with no file overlap. Safe to batch."
    },
    {
      "dipId": "dip-2",
      "storyIds": ["ORKY-38"],
      "rationale": "Story 9.3 modifies forgeClient.ts which 9.4 also modifies. Must be separate to avoid conflicts."
    }
  ]
}

No markdown fences. No explanation outside the JSON. Just the JSON object.`;
  }

  private parsePacketPlan(rawText: string): PacketPlan | null {
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No JSON object found in Forge Packet Plan response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as PacketPlan;

      if (!parsed.packetPlan || !Array.isArray(parsed.packetPlan)) {
        logger.warn('Parsed Packet Plan missing packetPlan array');
        return null;
      }

      return parsed;
    } catch (err: unknown) {
      logger.warn('Failed to parse Packet Plan JSON', { err });
      return null;
    }
  }

  private validatePacketPlan(
    packetPlan: PacketPlan,
    stories: StoryPayload[]
  ): string | null {
    const allStoryIds = stories.map(s => s.storyId);
    const planStoryIds = new Set<string>();

    for (const dip of packetPlan.packetPlan) {
      if (!dip.dipId || typeof dip.dipId !== 'string') {
        return 'Packet Plan contains DIP with missing or invalid dipId';
      }

      if (!Array.isArray(dip.storyIds) || dip.storyIds.length === 0) {
        return `DIP ${dip.dipId} has no storyIds`;
      }

      if (!dip.rationale || typeof dip.rationale !== 'string') {
        return `DIP ${dip.dipId} missing rationale`;
      }

      for (const storyId of dip.storyIds) {
        if (planStoryIds.has(storyId)) {
          return `Story ${storyId} appears in multiple DIPs`;
        }
        planStoryIds.add(storyId);
      }
    }

    for (const storyId of allStoryIds) {
      if (!planStoryIds.has(storyId)) {
        return `Story ${storyId} is missing from Packet Plan`;
      }
    }

    for (const storyId of planStoryIds) {
      if (!allStoryIds.includes(storyId)) {
        return `Packet Plan includes unknown story ${storyId}`;
      }
    }

    return null;
  }
}
