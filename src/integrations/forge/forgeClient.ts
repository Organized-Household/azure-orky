import Anthropic from '@anthropic-ai/sdk';
import type { StoryPayload } from '../../domain/storyPayload.js';
import type { ProjectContext } from '../../domain/projectContext.js';

export class ForgeClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    this.client = new Anthropic({ apiKey });
  }

  async generateInstructionPacket(
    storyPayload: StoryPayload,
    projectContexts: ProjectContext[]
  ): Promise<unknown> {
    const prompt = this.buildPrompt(storyPayload, projectContexts);

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200000,
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
      throw new Error('No text content in Forge response');
    }

    let cleanedText = textContent.text.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/^```json\s*/, '');
    }
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```\s*/, '');
    }
    if (cleanedText.endsWith('```')) {
      cleanedText = cleanedText.replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(cleanedText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Forge response as JSON: ${message}`);
    }
  }

  private buildPrompt(storyPayload: StoryPayload, projectContexts: ProjectContext[]): string {
    const artifactsSection = projectContexts
      .map(
        (ctx) =>
          `### ${ctx.artifactType}\n${JSON.stringify(ctx.artifactData, null, 2)}`
      )
      .join('\n\n');

    return `You are Forge, Senior SaaS Engineer implementing Orky, the AI-Orchestrated SaaS Engineering System.

You implement specifications exactly as written. You write safe, production-quality Developer Instruction Packets (DIPs) for Claude Code to execute.

## Tech Stack
- Node.js + TypeScript, Supabase PostgreSQL, Railway Container (node:22-alpine)
- GitHub repo: orkyai25-ctrl/orky, default branch: dev
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
- Logging: console.log() and console.error() only — never import a logger library (no winston, pino, bunyan, utils/logger, or any logger module)
- Forge is invoked via @anthropic-ai/sdk (already installed) — never via fetch(), axios, or any HTTP client
- Never create or modify src/config/env.ts — read env vars directly with process.env
- Never add required env var checks that would block startup — new env vars must have safe defaults or be optional
- No new model files in src/db/models/ unless the story explicitly requires a TypeScript interface for a new table
- All new DB repositories follow the pattern in src/db/repositories/executionRepository.ts: getPool(), $1/$2 params, catch (err: unknown)
- Claude API model string must be exactly 'claude-sonnet-4-5' — never any other model identifier
- Never import from a module that does not appear in the codebase snapshot or in fileOperations of this DIP — if a dependency does not exist, create it in fileOperations or use an existing module
- StoryPayload fields: storyId (string), title (string), description (string), acceptanceCriteria (string — NOT string[]), jiraIssueKey (string), PDEStoryID (string), PDEEpicID (string | undefined)
- If a fileOperation creates a DB repository that queries a table, fileOperations MUST also include the migration SQL file for that table
- Migration files MUST be placed at migrations/<NNN>_description.sql at the repo root — NEVER inside src/ or any subdirectory
- Migration numbering: use the next sequential number after the highest existing migration
- If a table already exists in the migration inventory, do NOT create it again — add an ALTER TABLE migration instead
- AuditLogger.log() signature: { executionId: string, storyId: string, step: string, state: string, status: string, message?: string, metadata?: unknown } — executionId and storyId are never null, use '' if not applicable; metadata takes an object (not a JSON string); there is no timestamp field
- Project context artifacts are fetched via ProjectContextRepository.getByProjectKey(storyPayload.projectKey) — never getAll()

---

## Project Context (PDE Artifacts)

${artifactsSection}

---

## Story to Implement

**Jira Issue:** ${storyPayload.jiraIssueKey}
**Title:** ${storyPayload.title}
**Description:**
${storyPayload.description}

**Acceptance Criteria:**
${storyPayload.acceptanceCriteria}

---

## Required Output

Return ONLY a single valid JSON object. No markdown fences. No explanation. No text outside the JSON.

Schema:
{
  "packetId": "<uuid>",
  "storyId": "${storyPayload.storyId}",
  "targetRepository": "orkyai25-ctrl/orky",
  "baseBranch": "dev",
  "branchNameHint": "<kebab-case hint>",
  "fileOperations": [
    {
      "operation": "create|modify|replace|delete",
      "path": "<repo-relative path>",
      "content": "<full file content for create/modify/replace>"
    }
  ],
  "validationCommands": [],
  "prTitle": "<concise PR title>",
  "prBody": "<full markdown PR description>",
  "commitMessage": "<conventional commit message>",
  "implementationSummary": "<human-readable summary>",
  "jiraLinkage": "${storyPayload.jiraIssueKey}"
}`;
  }
}
