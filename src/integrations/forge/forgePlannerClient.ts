import Anthropic from '@anthropic-ai/sdk';
import { StoryPayload } from '../../domain/storyPayload';

export interface PacketPlanDIP {
  dipId: string;
  storyIds: string[];
  rationale: string;
}

export interface PacketPlan {
  packetPlan: PacketPlanDIP[];
}

export class ForgePlannerClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    this.client = new Anthropic({ apiKey });
  }

  async generatePacketPlan(
    stories: StoryPayload[],
    artifacts: { baPack: string; pdd: string; systemArch: string }
  ): Promise<PacketPlan> {
    const prompt = this.buildPlanningPrompt(stories, artifacts);

    console.log(`[ForgePlannerClient] Invoking Forge for packet planning with ${stories.length} stories`);

    try {
      const response = await this.client.messages.create({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 16000,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const textContent = response.content.find((block) => block.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('Forge response did not contain text content');
      }

      const rawText = textContent.text.trim();
      const packetPlan = this.parsePacketPlan(rawText);
      this.validatePacketPlan(packetPlan, stories);

      console.log(`[ForgePlannerClient] Packet plan received with ${packetPlan.packetPlan.length} DIPs`);
      return packetPlan;
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[ForgePlannerClient] Forge planning invocation failed: ${err.message}`);
        throw new Error(`Forge planning failed: ${err.message}`);
      }
      throw new Error('Forge planning failed with unknown error');
    }
  }

  private buildPlanningPrompt(
    stories: StoryPayload[],
    artifacts: { baPack: string; pdd: string; systemArch: string }
  ): string {
    const storyList = stories
      .map(
        (s) =>
          `Story ID: ${s.storyId}\nTitle: ${s.title}\nDescription: ${s.description}\nAcceptance Criteria:\n${s.acceptanceCriteria.join('\n')}\n`
      )
      .join('\n---\n\n');

    return `You are Forge, Senior SaaS Engineer planning Developer Instruction Packets (DIPs) for Orky.

You have been given a batch of ${stories.length} ready stories from the same epic. Your task is to produce a Packet Plan — a structured JSON document that decides how many DIPs to generate, which stories belong in each DIP, and why.

## Planning Rules

1. **Group stories with no file overlap**: If multiple stories can be safely implemented without touching the same files, they may be batched into a single DIP.
2. **Keep stories that touch the same files in separate DIPs**: If two stories modify the same file, they must be in separate DIPs to avoid merge conflicts.
3. **Respect sequential dependencies**: If story B depends on story A being merged first, they must be in separate DIPs and ordered accordingly.
4. **Every story must appear in exactly one DIP**: No duplicates, no omissions.
5. **Rationale is required**: Each DIP must include a clear explanation of why those stories were grouped together or separated.

## Context Artifacts

### BA Pack
${artifacts.baPack}

### Product Design Document
${artifacts.pdd}

### System Architecture
${artifacts.systemArch}

## Stories to Plan

${storyList}

## Required Output

Return ONLY a valid JSON object matching this schema. No markdown fences. No explanation outside the JSON.

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

Generate the Packet Plan now.`;
  }

  private parsePacketPlan(rawText: string): PacketPlan {
    let jsonText = rawText.trim();

    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '');
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '');
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(jsonText);
      return parsed as PacketPlan;
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new Error(`Failed to parse Packet Plan JSON: ${err.message}`);
      }
      throw new Error('Failed to parse Packet Plan JSON');
    }
  }

  private validatePacketPlan(plan: PacketPlan, stories: StoryPayload[]): void {
    if (!plan.packetPlan || !Array.isArray(plan.packetPlan)) {
      throw new Error('Packet Plan must contain a packetPlan array');
    }

    if (plan.packetPlan.length === 0) {
      throw new Error('Packet Plan must contain at least one DIP');
    }

    const allStoryIds = stories.map((s) => s.storyId);
    const seenStoryIds = new Set<string>();

    for (const dip of plan.packetPlan) {
      if (!dip.dipId || typeof dip.dipId !== 'string') {
        throw new Error('Each DIP must have a valid dipId');
      }

      if (!dip.storyIds || !Array.isArray(dip.storyIds) || dip.storyIds.length === 0) {
        throw new Error(`DIP ${dip.dipId} must contain at least one storyId`);
      }

      if (!dip.rationale || typeof dip.rationale !== 'string') {
        throw new Error(`DIP ${dip.dipId} must include a rationale`);
      }

      for (const storyId of dip.storyIds) {
        if (!allStoryIds.includes(storyId)) {
          throw new Error(`DIP ${dip.dipId} references unknown story: ${storyId}`);
        }

        if (seenStoryIds.has(storyId)) {
          throw new Error(`Story ${storyId} appears in multiple DIPs`);
        }

        seenStoryIds.add(storyId);
      }
    }

    for (const storyId of allStoryIds) {
      if (!seenStoryIds.has(storyId)) {
        throw new Error(`Story ${storyId} is missing from the Packet Plan`);
      }
    }

    console.log('[ForgePlannerClient] Packet Plan validation passed');
  }
}
