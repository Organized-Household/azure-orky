import { ForgeConfig } from '../../config/env';


export interface PacketPlanEntry {
  dipId: string;
  storyIds: string[];
  rationale: string;
}

export interface PacketPlan {
  packetPlan: PacketPlanEntry[];
}

export interface StoryForPlanning {
  storyId: string;
  summary: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface ForgePlanningRequest {
  stories: StoryForPlanning[];
  epicId: string;
  projectKey: string;
}

export interface ForgePlanningResponse {
  packetPlan: PacketPlanEntry[];
}

export class ForgePlannerClient {
  private readonly forgeConfig: ForgeConfig;

  constructor(forgeConfig: ForgeConfig) {
    this.forgeConfig = forgeConfig;
  }

  async requestPacketPlan(request: ForgePlanningRequest): Promise<PacketPlan> {
    console.log('Requesting Packet Plan from Forge', {
      epicId: request.epicId,
      storyCount: request.stories.length,
      storyIds: request.stories.map(s => s.storyId)
    });

    const planningPrompt = this.buildPlanningPrompt(request);

    try {
      const response = await this.callForgeAPI(planningPrompt);
      const parsed = this.parseForgeResponse(response);
      this.validatePacketPlan(parsed, request.stories.map(s => s.storyId));

      console.log('Packet Plan received and validated', {
        dipCount: parsed.packetPlan.length,
        packetPlan: parsed.packetPlan
      });

      return parsed;
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Forge Packet Plan request failed', {
          error: err.message,
          epicId: request.epicId
        });
        throw new Error(`Forge Packet Plan request failed: ${err.message}`);
      }
      throw new Error('Forge Packet Plan request failed with unknown error');
    }
  }

  private buildPlanningPrompt(request: ForgePlanningRequest): string {
    const storyList = request.stories
      .map(
        (s, idx) =>
          `Story ${idx + 1}: ${s.storyId}\nSummary: ${s.summary}\nDescription: ${s.description}\nAcceptance Criteria:\n${s.acceptanceCriteria.map(ac => `- ${ac}`).join('\n')}\n`
      )
      .join('\n---\n\n');

    return `You are Forge, the AI Senior SaaS Engineer for Orky.

You have received a batch of ${request.stories.length} stories from epic ${request.epicId} in project ${request.projectKey}.

Your task is to produce a Packet Plan that decides how to group these stories into Developer Instruction Packets (DIPs).

## Planning Rules:
1. Group stories with no file overlap into the same DIP when safe to do so.
2. Keep stories that touch the same files in separate DIPs to avoid merge conflicts.
3. Respect sequential dependencies: if story B depends on story A, they must be in separate DIPs and A must come first.
4. Each story must appear in exactly one DIP.
5. Every dipId must be unique.
6. Provide a clear rationale for each grouping decision.

## Stories to Plan:

${storyList}

## Required Output Format:

Return ONLY valid JSON matching this schema:

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

Do not include markdown fences, explanations, or any text outside the JSON object.`;
  }

  private async callForgeAPI(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.forgeConfig.timeoutMs);

    try {
      const response = await fetch(this.forgeConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.forgeConfig.apiKey}`
        },
        body: JSON.stringify({
          model: this.forgeConfig.model,
          max_tokens: this.forgeConfig.maxTokens,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Forge API returned ${response.status}: ${errorText}`);
      }

      const json = await response.json();
      const content = json?.content?.[0]?.text;

      if (!content) {
        throw new Error('Forge API response missing content');
      }

      return content;
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Forge API request timed out after ${this.forgeConfig.timeoutMs}ms`);
      }
      throw err;
    }
  }

  private parseForgeResponse(responseText: string): PacketPlan {
    try {
      const cleaned = responseText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleaned);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Response is not a valid JSON object');
      }

      if (!Array.isArray(parsed.packetPlan)) {
        throw new Error('packetPlan field is missing or not an array');
      }

      return parsed as PacketPlan;
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new Error(`Failed to parse Forge Packet Plan response: ${err.message}`);
      }
      throw new Error('Failed to parse Forge Packet Plan response: unknown error');
    }
  }

  private validatePacketPlan(plan: PacketPlan, expectedStoryIds: string[]): void {
    const allStoryIdsInPlan: string[] = [];
    const dipIds = new Set<string>();

    for (const entry of plan.packetPlan) {
      if (!entry.dipId || typeof entry.dipId !== 'string') {
        throw new Error('Packet Plan entry missing valid dipId');
      }

      if (dipIds.has(entry.dipId)) {
        throw new Error(`Duplicate dipId in Packet Plan: ${entry.dipId}`);
      }
      dipIds.add(entry.dipId);

      if (!Array.isArray(entry.storyIds) || entry.storyIds.length === 0) {
        throw new Error(`Packet Plan entry ${entry.dipId} has invalid or empty storyIds`);
      }

      if (!entry.rationale || typeof entry.rationale !== 'string') {
        throw new Error(`Packet Plan entry ${entry.dipId} missing rationale`);
      }

      allStoryIdsInPlan.push(...entry.storyIds);
    }

    const storyIdSet = new Set(allStoryIdsInPlan);
    if (storyIdSet.size !== allStoryIdsInPlan.length) {
      throw new Error('Packet Plan contains duplicate storyIds across DIPs');
    }

    const expectedSet = new Set(expectedStoryIds);
    const missingStories = expectedStoryIds.filter(id => !storyIdSet.has(id));
    const extraStories = allStoryIdsInPlan.filter(id => !expectedSet.has(id));

    if (missingStories.length > 0) {
      throw new Error(`Packet Plan is missing stories: ${missingStories.join(', ')}`);
    }

    if (extraStories.length > 0) {
      throw new Error(`Packet Plan contains unexpected stories: ${extraStories.join(', ')}`);
    }

    console.log('Packet Plan validation passed', {
      dipCount: plan.packetPlan.length,
      totalStories: allStoryIdsInPlan.length
    });
  }
}
