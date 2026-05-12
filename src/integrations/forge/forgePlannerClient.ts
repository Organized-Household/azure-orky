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
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async generatePacketPlan(
    stories: StoryPayload[],
    projectContext: string,
  ): Promise<PacketPlan> {
    const prompt = this.buildPlanningPrompt(stories, projectContext);

    console.log(`[ForgePlannerClient] Invoking Forge for packet planning with ${stories.length} stories`);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });

      const textContent = response.content.find((block) => block.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('Forge response did not contain text content');
      }

      const packetPlan = this.parsePacketPlan(textContent.text);
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

  private buildPlanningPrompt(stories: StoryPayload[], projectContext: string): string {
    const storyList = stories
      .map(
        (s) =>
          `Story ID: ${s.storyId}\nTitle: ${s.title}\nDescription: ${s.description}\nAcceptance Criteria:\n${s.acceptanceCriteria}\n`,
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

## Project Context

${projectContext}

## Stories to Plan

${storyList}

## Required Output

Return ONLY a valid JSON object. No markdown fences. No explanation outside the JSON.

{
  "packetPlan": [
    {
      "dipId": "dip-1",
      "storyIds": ["ORKY-36", "ORKY-37"],
      "rationale": "Stories 9.1 and 9.2 both add new tables and repositories with no file overlap. Safe to batch."
    }
  ]
}

Generate the Packet Plan now.`;
  }

  private parsePacketPlan(rawText: string): PacketPlan {
    const jsonText = rawText
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');

    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    const extracted = start !== -1 && end > start ? jsonText.slice(start, end + 1) : jsonText;

    try {
      return JSON.parse(extracted) as PacketPlan;
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new Error(`Failed to parse Packet Plan JSON: ${err.message}`);
      }
      throw new Error('Failed to parse Packet Plan JSON');
    }
  }

  private validatePacketPlan(plan: PacketPlan, stories: StoryPayload[]): void {
    if (!plan.packetPlan || !Array.isArray(plan.packetPlan) || plan.packetPlan.length === 0) {
      throw new Error('Packet Plan must contain a non-empty packetPlan array');
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
