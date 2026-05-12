import Anthropic from '@anthropic-ai/sdk';
import { InstructionPacket } from '../../domain/instructionPacket';
import { AuditLogger } from '../../audit/auditLogger';

export type ReviewVerdict = 'APPROVED' | 'QUESTIONS';

export interface PacketReviewResult {
  verdict: ReviewVerdict;
  issues: string[];
}

export class PacketReviewer {
  private client: Anthropic;
  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.client = new Anthropic();
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
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const firstBlock = response.content[0];
      if (firstBlock.type !== 'text') {
        throw new Error('Unexpected non-text response block from Claude API');
      }
      rawText = firstBlock.text;
    } catch (err: unknown) {
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
- Do not raise style or preference issues — only raise issues that would cause execution failure or produce incorrect output
- Do not comment on the DIP format itself — only on codebase compatibility

## Developer Instruction Packet

\`\`\`json
${JSON.stringify(packet, null, 2)}
\`\`\`

## Current Codebase Snapshot

${codebaseSnapshot}

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
