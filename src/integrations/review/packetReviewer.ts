import { InstructionPacket } from '../../domain/instructionPacket';
import { AuditLogger } from '../../audit/auditLogger';
import { AnthropicRetryClient, AnthropicRetryExhaustedError } from '../anthropic/anthropicRetryClient';

export type ReviewVerdict = 'APPROVED' | 'QUESTIONS';

export interface PacketReviewResult {
  verdict: ReviewVerdict;
  issues: string[];
}

export class PacketReviewer {
  private retryClient: AnthropicRetryClient;
  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.retryClient = new AnthropicRetryClient();
    this.auditLogger = auditLogger;
  }

  async review(
    executionId: string,
    storyId: string,
    packet: InstructionPacket,
    codebaseSnapshot: string,
  ): Promise<PacketReviewResult> {
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'packet_review_started',
      state: 'NEGOTIATING',
      status: 'info',
      message: 'Submitting DIP to Claude for compatibility review',
    });

    const prompt = this.buildReviewPrompt(packet, codebaseSnapshot);

    let rawText: string;
    try {
      const response = await this.retryClient.createMessage(
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        },
        async (retryInfo) => {
          console.log(
            `[PacketReviewer] Retry attempt ${retryInfo.attempt}/${retryInfo.maxRetries} — waiting ${retryInfo.waitMs}ms`,
          );
          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'api_retry',
            state: 'negotiating',
            status: 'retrying',
            message: `Anthropic API retry — attempt ${retryInfo.attempt} of ${retryInfo.maxRetries}, waiting ${retryInfo.waitMs}ms`,
            metadata: {
              attempt: retryInfo.attempt,
              maxRetries: retryInfo.maxRetries,
              waitMs: retryInfo.waitMs,
              errorMessage: retryInfo.errorMessage,
            },
          });
        },
      );

      const firstBlock = response.content[0];
      if (firstBlock.type !== 'text') {
        throw new Error('Unexpected non-text response block from Claude API');
      }
      rawText = firstBlock.text;
    } catch (err: unknown) {
      if (err instanceof AnthropicRetryExhaustedError) {
        const message = err.message;
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'packet_review_failed',
          state: 'NEGOTIATING',
          status: 'error',
          message: `Claude API call failed — ${message}`,
        });
        throw new Error(`PacketReviewer: Claude API call failed — ${message}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'packet_review_failed',
        state: 'NEGOTIATING',
        status: 'error',
        message: `Claude API call failed — ${message}`,
      });
      throw new Error(`PacketReviewer: Claude API call failed — ${message}`);
    }

    let result: PacketReviewResult;
    try {
      result = this.parseReviewResponse(rawText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'packet_review_parse_failed',
        state: 'NEGOTIATING',
        status: 'error',
        message: `Failed to parse review response — ${message}`,
      });
      throw new Error(`PacketReviewer: failed to parse review response — ${message}`);
    }

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'packet_review_completed',
      state: 'NEGOTIATING',
      status: 'info',
      message: `Reviewer verdict: ${result.verdict} (${result.issues.length} issue(s))`,
    });

    return result;
  }

  private buildReviewPrompt(packet: InstructionPacket, codebaseSnapshot: string): string {
    const snapshotSection = codebaseSnapshot.trim()
      ? codebaseSnapshot
      : '_(No codebase snapshot available — approve unless the DIP contains an obvious self-contradiction)_';

    return `You are a senior engineer reviewing a Developer Instruction Packet (DIP) for codebase compatibility before execution.

Your job is to determine whether the DIP is safe to execute against the current codebase as written, or whether it contains issues that must be resolved first.

Respond ONLY with a valid JSON object. Do not include markdown fences, explanation, or any text outside the JSON object.

Response format:
{
  "verdict": "APPROVED" | "QUESTIONS",
  "issues": []
}

Rules:
- "verdict" must be exactly "APPROVED" or "QUESTIONS"
- "issues" must be an array of strings
- If verdict is "APPROVED", issues must be an empty array
- If verdict is "QUESTIONS", issues must contain one or more specific, actionable compatibility concerns
- Only raise an issue when you can POSITIVELY IDENTIFY a conflict with the observed codebase — do NOT raise issues based on uncertainty or inability to verify
- If the codebase snapshot is empty, return APPROVED — you have no basis for any concern
- If the DIP uses operation "modify", "replace", or "delete" on a file path that does NOT appear anywhere in the codebase snapshot, flag that specific path as a concern in QUESTIONS — you cannot verify it is safe to overwrite. New file creation (operation "create") for paths absent from the snapshot is expected and fine.
- Do not raise style or preference issues — only raise issues that would cause execution failure or produce incorrect output
- Do not comment on the DIP format itself — only on codebase compatibility
- "validationCommands": [] is correct and by design in this project — never flag it as an issue

## Developer Instruction Packet

\`\`\`json
${JSON.stringify(packet, null, 2)}
\`\`\`

## Current Codebase Snapshot

${snapshotSection}

Review the DIP against the codebase snapshot and respond with your JSON verdict now.`;
  }

  private parseReviewResponse(raw: string): PacketReviewResult {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      throw new Error(`Response is not valid JSON: ${stripped.slice(0, 200)}`);
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('verdict' in parsed) ||
      !('issues' in parsed)
    ) {
      throw new Error('Response JSON missing required fields: verdict, issues');
    }

    const obj = parsed as Record<string, unknown>;

    if (obj['verdict'] !== 'APPROVED' && obj['verdict'] !== 'QUESTIONS') {
      throw new Error(`Invalid verdict value: ${String(obj['verdict'])}`);
    }

    if (!Array.isArray(obj['issues'])) {
      throw new Error('issues must be an array');
    }

    const issues = (obj['issues'] as unknown[]).map((item, i) => {
      if (typeof item !== 'string') {
        throw new Error(`issues[${i}] is not a string`);
      }
      return item;
    });

    return {
      verdict: obj['verdict'] as ReviewVerdict,
      issues,
    };
  }
}
