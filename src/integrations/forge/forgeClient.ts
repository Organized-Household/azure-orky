import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
} from '@anthropic-ai/sdk';
import { StoryPayload } from '../../domain/storyPayload';
import { InstructionPacket } from '../../domain/instructionPacket';
import { ProjectContextRepository } from '../../db/repositories/projectContextRepository';
import { DecisionLogRepository } from '../../db/repositories/decisionLogRepository';
import { CodebaseSnapshotFetcher } from '../github/codebaseSnapshotFetcher';

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
    const context = await this.assembleContext(storyPayload);
    const prompt = this.buildPrompt(storyPayload, context);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs[attempt - 1]);
      }

      try {
        const response = await this.client.messages.create(
          {
            model: 'claude-sonnet-4-5',
            max_tokens: 8192,
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
        if (error instanceof ForgeInvocationError) throw error;
        if (isRetryable(error)) { lastError = error; continue; }
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

  async revise(storyPayload: StoryPayload, issues: string[]): Promise<InstructionPacket> {
    const context = await this.assembleContext(storyPayload);
    const basePrompt = this.buildPrompt(storyPayload, context);
    const issueList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
    const prompt = `${basePrompt}

---

## Revision Required

A reviewer has identified the following compatibility issues with the previous packet. You must address ALL of them in your revised output:

${issueList}

Return a corrected JSON packet that resolves every issue listed above.`;

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs[attempt - 1]);
      }

      try {
        const response = await this.client.messages.create(
          {
            model: 'claude-sonnet-4-5',
            max_tokens: 8192,
            messages: [{ role: 'user', content: prompt }],
          },
          { timeout: this.timeoutMs },
        );

        const block = response.content[0];
        const text = block.type === 'text' ? block.text : '';
        const cleaned = stripMarkdownFences(text);

        try {
          return JSON.parse(cleaned) as InstructionPacket;
        } catch {
          throw new ForgeInvocationError(
            'FORGE_PARSE_ERROR',
            `Forge revision response is not valid JSON: ${cleaned.slice(0, 300)}`,
          );
        }
      } catch (error) {
        if (error instanceof ForgeInvocationError) throw error;
        if (isRetryable(error)) { lastError = error; continue; }
        throw new ForgeInvocationError(
          'FORGE_HTTP_ERROR',
          `Forge revision request failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }

    const isTimeout = lastError instanceof APIConnectionTimeoutError;
    throw new ForgeInvocationError(
      isTimeout ? 'FORGE_TIMEOUT' : 'FORGE_HTTP_ERROR',
      isTimeout
        ? 'Forge revision request timed out after all retries'
        : `Forge revision request failed after all retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  private async assembleContext(storyPayload: StoryPayload): Promise<{
    projectContext: string;
    implementationHistory: string;
    codebaseSnapshot: string;
  }> {
    const epicId = storyPayload.PDEEpicID ?? storyPayload.epicId ?? '';

    // 1. Project context (PDE artifacts) — non-fatal
    let projectContext = '';
    try {
      const projectContextRepo = new ProjectContextRepository();
      const artifacts = await projectContextRepo.getAll();
      if (artifacts.length > 0) {
        projectContext = artifacts
          .map((a) => `### ${a.artifactType.toUpperCase()}\n${a.content}`)
          .join('\n\n');
      } else {
        projectContext = '_(No PDE artifacts seeded yet — seed the project_context table)_';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      projectContext = `_(PDE artifact fetch failed: ${msg})_`;
    }

    // 2. Implementation history (decision logs) — non-fatal
    let implementationHistory = '';
    try {
      if (epicId) {
        const decisionLogRepo = new DecisionLogRepository();
        const logs = await decisionLogRepo.getRecentByEpic(epicId, 5);
        if (logs.length > 0) {
          implementationHistory = logs
            .map(
              (log) =>
                `**${log.storyId}** (${log.createdAt.toISOString().slice(0, 10)})\n` +
                `Files: ${log.filesChanged}\n` +
                `Patterns: ${log.patternsUsed}\n` +
                (log.migrationApplied ? `Migration: ${log.migrationApplied}\n` : '') +
                `Summary: ${log.summary}`,
            )
            .join('\n\n---\n\n');
        } else {
          implementationHistory = '_(No prior implementation history for this epic)_';
        }
      } else {
        implementationHistory = '_(Epic ID not available — history skipped)_';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      implementationHistory = `_(Implementation history fetch failed: ${msg})_`;
    }

    // 3. Codebase snapshot — non-fatal
    let codebaseSnapshot = '';
    try {
      const fetcher = new CodebaseSnapshotFetcher();
      const snapshot = await fetcher.fetchForEpic(epicId);
      if (snapshot.files.length > 0) {
        codebaseSnapshot = snapshot.files
          .map(
            (f) =>
              `#### \`${f.path}\`${f.truncated ? ' _(truncated)_' : ''}\n\`\`\`typescript\n${f.content}\n\`\`\``,
          )
          .join('\n\n');
        if (snapshot.warnings.length > 0) {
          codebaseSnapshot += `\n\n_Warnings: ${snapshot.warnings.join('; ')}_`;
        }
      } else {
        codebaseSnapshot = `_(No codebase snapshot available${snapshot.warnings.length > 0 ? `: ${snapshot.warnings.join('; ')}` : ''})_`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      codebaseSnapshot = `_(Codebase snapshot fetch failed: ${msg} — proceeding without snapshot)_`;
    }

    return { projectContext, implementationHistory, codebaseSnapshot };
  }

  private buildPrompt(
    storyPayload: StoryPayload,
    context: { projectContext: string; implementationHistory: string; codebaseSnapshot: string },
  ): string {
    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER ?? 'unknown-owner';
    const epicId = storyPayload.PDEEpicID ?? storyPayload.epicId ?? '';

    return `You are Forge, Senior SaaS Engineer implementing Orky, the AI-Orchestrated SaaS Engineering System.

You implement specifications exactly as written. You write safe, production-quality Developer Instruction Packets (DIPs) for Claude Code to execute.

## Tech Stack
- Node.js + TypeScript, Supabase PostgreSQL, Railway Container (node:22-alpine)
- GitHub repo: ${repoOwner}/orky, default branch: dev
- pg driver — $1/$2 positional params only. Never named params.

## Hard Constraints — Never Violate
- getPool() from src/db/dbClient.ts — never new Pool()
- FileOperation.path not .filePath
- All PRs target dev branch, never main
- GH_TOKEN env var — never GITHUB_TOKEN
- Constructor pattern: positional args — never a deps object
- catch (err: unknown) with explicit narrowing — never catch (err: any)
- validationCommands: always []
- storyPayload.title not .summary
- No new npm packages without Architect approval
- No standalone services — integrate into existing src/ module structure
- Never log GH_TOKEN, ANTHROPIC_API_KEY, or any credential

## Execution State Machine
RECEIVED → VALIDATED → STORY_FETCHED → ARTIFACTS_RESOLVED →
FORGE_INVOKED → PACKET_RECEIVED → PACKET_VALIDATED →
AGENT_EXECUTING → CHANGES_PREPARED → PR_CREATED →
CI_PENDING → CI_PASSED → MERGED → COMPLETED
Any state → FAILED (terminal)

---

## Project Context (PDE Artifacts)

${context.projectContext}

---

## Implementation History (Last 5 decisions for ${epicId || 'this epic'})

${context.implementationHistory}

---

## Current Codebase (Relevant files for ${epicId || 'this epic'})

${context.codebaseSnapshot}

---

## Story to Implement

ID: ${storyPayload.storyId}
Jira Key: ${storyPayload.jiraIssueKey ?? ''}
Summary: ${storyPayload.title}
Description: ${storyPayload.description}
Acceptance Criteria: ${storyPayload.acceptanceCriteria}
Epic ID: ${epicId}
Project Key: ${storyPayload.projectKey}

---

## Required Output

Return ONLY a single valid JSON object. No markdown fences. No explanation. No text outside the JSON.

Schema:
{
  "packetId": "<uuid>",
  "storyId": "${storyPayload.storyId}",
  "targetRepository": "${repoOwner}/orky",
  "baseBranch": "dev",
  "branchNameHint": "<kebab-case hint from story summary>",
  "fileOperations": [
    {
      "operation": "create|modify|replace|delete",
      "path": "<repo-relative path>",
      "content": "<full file content for create/modify/replace>"
    }
  ],
  "validationCommands": [],
  "prTitle": "<concise PR title referencing story ID>",
  "prBody": "<full markdown PR description: What this does / Files created/modified / Acceptance criteria covered / Closes ${storyPayload.jiraIssueKey ?? storyPayload.storyId}>",
  "commitMessage": "<conventional commit: feat(storyId): description>",
  "implementationSummary": "<human-readable summary of what was built and why, for the decision log>",
  "jiraLinkage": "${storyPayload.jiraIssueKey ?? storyPayload.storyId}"
}`;
  }
}
