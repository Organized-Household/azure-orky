import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
} from '@anthropic-ai/sdk';
import { StoryPayload } from '../../domain/storyPayload';
import { InstructionPacket } from '../../domain/instructionPacket';

export class ForgeInvocationError extends Error {
  constructor(
    public readonly code: 'FORGE_TIMEOUT' | 'FORGE_HTTP_ERROR' | 'FORGE_PARSE_ERROR',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ForgeInvocationError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof APIConnectionTimeoutError ||
    error instanceof InternalServerError ||
    (error instanceof APIError && error.status >= 500)
  );
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export class ForgeClient {
  private client: Anthropic;
  private readonly timeoutMs = 120_000;
  private readonly maxRetries = 3;
  private readonly backoffMs = [5_000, 30_000, 120_000];

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
    });
  }

  async generateInstructionPacket(storyPayload: StoryPayload): Promise<InstructionPacket> {
    const prompt = this.buildPrompt(storyPayload);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs[attempt - 1]);
      }

      try {
        const response = await this.client.messages.create(
          {
            model: 'claude-sonnet-4-5',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          },
          { timeout: this.timeoutMs },
        );

        const block = response.content[0];
        const text = block.type === 'text' ? block.text : '';
        const cleaned = stripMarkdownFences(text);

        console.log('[ForgeClient] Raw response length:', text.length);
        console.log('[ForgeClient] Cleaned response preview:', cleaned.slice(0, 200));

        try {
          return JSON.parse(cleaned) as InstructionPacket;
        } catch {
          throw new ForgeInvocationError(
            'FORGE_PARSE_ERROR',
            `Forge response is not valid JSON: ${cleaned.slice(0, 300)}`,
          );
        }
      } catch (error) {
        if (error instanceof ForgeInvocationError) {
          throw error;
        }

        if (isRetryable(error)) {
          lastError = error;
          continue;
        }

        throw new ForgeInvocationError(
          'FORGE_HTTP_ERROR',
          `Forge request failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }

    const isTimeout = lastError instanceof APIConnectionTimeoutError;
    throw new ForgeInvocationError(
      isTimeout ? 'FORGE_TIMEOUT' : 'FORGE_HTTP_ERROR',
      isTimeout
        ? 'Forge request timed out after all retries'
        : `Forge request failed after all retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  private buildPrompt(storyPayload: StoryPayload): string {
    return `You are Forge, a developer instruction generation system.

Given the following Jira story, produce a Developer Instruction Packet as a single valid JSON object.
Do NOT include markdown formatting, backticks, or any text outside the JSON object.
Return ONLY the raw JSON. No explanation. No code fences. No markdown. Just JSON.

Story:
ID: ${storyPayload.storyId}
Summary: ${storyPayload.title}
Description: ${storyPayload.description}
Acceptance Criteria: ${storyPayload.acceptanceCriteria}
Epic ID: ${storyPayload.PDEEpicID ?? storyPayload.epicId ?? ''}
Project Key: ${storyPayload.projectKey}

Return JSON matching this exact schema:
{
  "packetId": "<uuid>",
  "storyId": "<matches input storyId>",
  "targetRepository": "<inferred from projectKey>",
  "baseBranch": "main",
  "branchNameHint": "<kebab-case hint based on summary>",
  "fileOperations": [
    {
      "operation": "create" | "modify" | "replace" | "delete",
      "path": "<relative file path>",
      "content": "<file content for create/modify/replace>"
    }
  ],
  "validationCommands": ["<shell command to validate the changes>"]
}`;
  }
}