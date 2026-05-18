import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { StoryPayload } from '../../domain/storyPayload';
import { InstructionPacket } from '../../domain/instructionPacket';
import { ProjectContextRepository } from '../../db/repositories/projectContextRepository';
import { DecisionLogRepository } from '../../db/repositories/decisionLogRepository';
import { CodebaseSnapshotFetcher } from '../github/codebaseSnapshotFetcher';
import { buildConstraintBlock, FORGE_PROMPT_VERSION } from './forgeConstraints';
import { AuditLogger } from '../../audit/auditLogger';
import { AnthropicRetryClient, AnthropicRetryExhaustedError } from '../anthropic/anthropicRetryClient';
import { TokenUsageRepository } from '../../db/repositories/tokenUsageRepository';
import { CostGuard, CostGuardExceededError } from '../../orchestrator/costGuard';

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

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// Extract outermost JSON object from text that may have leading/trailing prose
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

export class ForgeClient {
  private retryClient: AnthropicRetryClient;
  private auditLogger: AuditLogger;
  private tokenUsageRepo: TokenUsageRepository;
  private costGuard: CostGuard;

  readonly promptVersion = FORGE_PROMPT_VERSION;

  constructor(auditLogger: AuditLogger) {
    this.retryClient = new AnthropicRetryClient();
    this.auditLogger = auditLogger;
    this.tokenUsageRepo = new TokenUsageRepository();
    this.costGuard = new CostGuard(this.tokenUsageRepo, this.auditLogger);
  }

  async generateInstructionPacket(
    executionId: string,
    storyId: string,
    storyPayload: StoryPayload,
  ): Promise<InstructionPacket> {
    await this.costGuard.check(executionId, storyId);

    const context = await this.assembleContext(storyPayload);
    const prompt = this.buildPrompt(storyPayload, context);

    let response: Anthropic.Message;
    try {
      response = await this.retryClient.createMessage(
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        },
        async (retryInfo) => {
          console.log(
            `[ForgeClient] Retry attempt ${retryInfo.attempt}/${retryInfo.maxRetries} — waiting ${retryInfo.waitMs}ms. Reason: ${retryInfo.errorMessage}`,
          );
          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'api_retry',
            state: 'forge_invoked',
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
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      let code: 'FORGE_TIMEOUT' | 'FORGE_HTTP_ERROR' = 'FORGE_HTTP_ERROR';
      if (err instanceof AnthropicRetryExhaustedError && err.code === 'TIMEOUT') {
        code = 'FORGE_TIMEOUT';
      }
      throw new ForgeInvocationError(code, error.message, err);
    }

    try {
      await this.tokenUsageRepo.record(executionId, 'forge_generate', response.usage.input_tokens, response.usage.output_tokens);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[ForgeClient] Failed to record token usage (forge_generate):', error.message);
    }

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
  }

  async revise(
    executionId: string,
    storyId: string,
    storyPayload: StoryPayload,
    issues: string[],
    currentPacket: InstructionPacket,
    contextFiles?: Record<string, string>,
  ): Promise<InstructionPacket> {
    await this.costGuard.check(executionId, storyId);

    // Revision prompt is intentionally slim — omits PDE artifacts, history, and codebase snapshot
    // (Forge already saw those in round 1). Only send what's needed to fix the specific errors.
    let migrationInventory = '';
    try {
      const migrationsDir = path.join(process.cwd(), 'migrations');
      migrationInventory = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .join('\n');
    } catch {
      migrationInventory = '_(unavailable)_';
    }

    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER ?? 'unknown-owner';
    const issueList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');

    const currentFilesSection = currentPacket.fileOperations
      .filter((op) => op.content !== undefined)
      .map((op) => `#### \`${op.path}\` (${op.operation})\n\`\`\`typescript\n${op.content}\n\`\`\``)
      .join('\n\n');

    const prompt = `You are Forge, Senior SaaS Engineer. Revise the Developer Instruction Packet (DIP) below to fix ALL listed issues.

## Story
ID: ${storyPayload.storyId} — ${storyPayload.title}

## Hard Constraints — Never Violate
- getPool() from src/db/dbClient.ts — never new Pool()
- $1/$2 positional params only — never named params
- catch (err: unknown) with explicit narrowing — never catch (err: any)
- validationCommands: always []
- Never import a logger library — console.log() and console.error() only
- All PRs target dev branch, never main
- GH_TOKEN env var — never GITHUB_TOKEN
- Migration files in migrations/<NNN>_description.sql at repo root — never inside src/
- AuditLogger.log() signature: { executionId: string, storyId: string, step: string, state: string, status: string, message?: string, metadata?: unknown }
- ExecutionRepository exact methods (NEVER rename): create, updateState(executionId, state, failureReason?), getById, failIfNotTerminal, acquireLock, releaseLock, hasActiveOrCompletedExecution
- BatchExecutionRepository.updateState(batchExecutionId, newState, failureReason?) — newState is typed as \`string\`, NEVER as a union type or enum — existing callers pass: 'STORIES_RETRIEVING', 'ARTIFACTS_RESOLVING', 'PACKET_PLANNING', 'PACKET_PLAN_APPROVED', 'DIPS_GENERATED', 'EXECUTING', 'COMPLETED', 'FAILED'
- NEVER define BatchExecutionState as a union type or enum — it breaks batchOrchestrator.ts
- Repository state-update methods MUST be named updateState — NEVER updateStatus
- BatchExecutionRow snake_case properties: batch_execution_id, epic_id, current_state, story_ids, packet_plan_json
- Claude API model string must be exactly 'claude-sonnet-4-5'

## Existing Migrations
${migrationInventory}

${contextFiles && Object.keys(contextFiles).length > 0
  ? `## Relevant Source Files (actual interfaces — use these, do not invent)\n\n${
      Object.entries(contextFiles)
        .map(([p, c]) => `#### \`${p}\`\n\`\`\`typescript\n${c}\n\`\`\``)
        .join('\n\n')
    }\n\n`
  : ''}## Your Previous DIP File Operations (fix the errors in these)

${currentFilesSection || '_(no file content available)_'}

## Issues to Fix

${issueList}

Return ONLY the corrected full JSON object. No markdown fences. No explanation. No text outside the JSON.

Schema:
{
  "packetId": "<uuid>",
  "storyId": "${storyPayload.storyId}",
  "targetRepository": "${repoOwner}/orky",
  "baseBranch": "dev",
  "branchNameHint": "<kebab-case>",
  "fileOperations": [{ "operation": "create|modify|replace|delete", "path": "<path>", "content": "<full content>" }],
  "validationCommands": [],
  "prTitle": "<title>",
  "prBody": "<markdown body>",
  "commitMessage": "<conventional commit>",
  "implementationSummary": "<summary>",
  "jiraLinkage": "${storyPayload.jiraIssueKey ?? storyPayload.storyId}"
}` + '\n\n' + buildConstraintBlock();

    let response: Anthropic.Message;
    try {
      response = await this.retryClient.createMessage(
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        },
        async (retryInfo) => {
          console.log(
            `[ForgeClient] Retry attempt ${retryInfo.attempt}/${retryInfo.maxRetries} — waiting ${retryInfo.waitMs}ms. Reason: ${retryInfo.errorMessage}`,
          );
          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'api_retry',
            state: 'forge_invoked',
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
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      let code: 'FORGE_TIMEOUT' | 'FORGE_HTTP_ERROR' = 'FORGE_HTTP_ERROR';
      if (err instanceof AnthropicRetryExhaustedError && err.code === 'TIMEOUT') {
        code = 'FORGE_TIMEOUT';
      }
      throw new ForgeInvocationError(code, error.message, err);
    }

    try {
      await this.tokenUsageRepo.record(executionId, 'forge_revise', response.usage.input_tokens, response.usage.output_tokens);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[ForgeClient] Failed to record token usage (forge_revise):', error.message);
    }

    const block = response.content[0];
    const text = block.type === 'text' ? block.text : '';
    const cleaned = extractJsonObject(stripMarkdownFences(text));

    try {
      return JSON.parse(cleaned) as InstructionPacket;
    } catch {
      throw new ForgeInvocationError(
        'FORGE_PARSE_ERROR',
        `Forge revision response is not valid JSON: ${cleaned.slice(0, 300)}`,
      );
    }
  }

  private async assembleContext(storyPayload: StoryPayload): Promise<{
    projectContext: string;
    implementationHistory: string;
    codebaseSnapshot: string;
    migrationInventory: string;
  }> {
    const epicId = storyPayload.PDEEpicID ?? storyPayload.epicId ?? '';

    // 1. Project context (PDE artifacts) — non-fatal
    let projectContext = '';
    try {
      const projectContextRepo = new ProjectContextRepository();
      const artifacts = await projectContextRepo.getByProjectKey(storyPayload.projectKey);
      if (artifacts.length > 0) {
        projectContext = artifacts
          .map((a) => `### ${a.artifactType.toUpperCase()}\n${a.content}`)
          .join('\n\n');
      } else {
        projectContext = `_(No PDE artifacts found for project ${storyPayload.projectKey} — seed the project_context table)_`;
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
      const snapshot = await fetcher.fetchForEpic(epicId, []);
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

    // 4. Migration inventory — non-fatal
    let migrationInventory = '';
    try {
      const migrationsDir = path.join(process.cwd(), 'migrations');
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      migrationInventory = files.join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      migrationInventory = `_(Migration inventory unavailable: ${msg})_`;
    }

    return { projectContext, implementationHistory, codebaseSnapshot, migrationInventory };
  }

  private buildPrompt(
    storyPayload: StoryPayload,
    context: {
      projectContext: string;
      implementationHistory: string;
      codebaseSnapshot: string;
      migrationInventory: string;
    },
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
- Migration numbering: use the next sequential number after the highest existing migration (see "Existing Migrations" section below)
- If a table already exists in the migration inventory, do NOT create it again — add an ALTER TABLE migration instead
- AuditLogger.log() signature: { executionId: string, storyId: string, step: string, state: string, status: string, message?: string, metadata?: unknown } — executionId and storyId are never null, use '' if not applicable; metadata takes an object (not a JSON string); there is no timestamp field
- Project context artifacts are fetched via ProjectContextRepository.getAll() in src/db/repositories/projectContextRepository.ts — never invent an ArtifactResolver or similar abstraction
- BatchedForgeClient method is generateBatchedDIP() — never generateDIP() or any other name
- PacketPlan shape: { packetPlan: PacketPlanDIP[] } — access as plan.packetPlan, never plan.groups or plan.dips
- BatchExecutionRepository.create() takes 5 positional args: (batchExecutionId, epicId, projectKey, storyIds, startedAt) — never a single object argument; storyIds MUST be typed as \`string[]\` — NEVER \`string\` or any other type
- BatchExecutionRepository.updatePacketPlan() second parameter packetPlan MUST be typed as \`PacketPlan\` — NEVER \`string\`, \`object\`, \`unknown\`, or any other type; the caller passes a PacketPlan directly, do NOT JSON.stringify() it
- \`batch_executions\` table ALREADY EXISTS (created by migration 011) — do NOT create it again in any migration; if a column is missing, use ALTER TABLE in a new migration numbered 013 or higher
- Next available migration number is 013 — NEVER reuse a number already in the migration inventory; migration 007 is taken by 007_create_project_context.sql
- ExecutionRepository has no findByStoryId() method — never invent methods not visible in the codebase snapshot
- ExecutionRepository exact methods (do NOT rename or remove any): create, updateState(executionId, state, failureReason?), getById, failIfNotTerminal, acquireLock, releaseLock, hasActiveOrCompletedExecution — never modify executionRepository.ts method signatures
- BatchExecutionRepository exact methods: create(5 positional args), findById, updatePacketPlan, updateState(batchExecutionId, newState, failureReason?) — NEVER updateStatus on any repository ever
- BatchExecutionRepository.updateState() newState parameter MUST remain typed as \`string\` — NEVER define a BatchExecutionState enum or union type; doing so breaks existing callers in batchOrchestrator.ts which pass: 'STORIES_RETRIEVING', 'ARTIFACTS_RESOLVING', 'PACKET_PLANNING', 'PACKET_PLAN_APPROVED', 'DIPS_GENERATED', 'EXECUTING', 'COMPLETED', 'FAILED'
- BatchExecutionRow is the raw DB row type — properties are snake_case: current_state, story_ids, epic_id, batch_execution_id, packet_plan_json — access exactly as snake_case when reading from findById()
- Repository state-update methods MUST be named updateState — NEVER updateStatus or any other variant in any repository, existing or new
- NEVER modify src/db/repositories/executionRepository.ts — it is shared infrastructure used by all epics; only ADD to it if the story explicitly requires a new method on ExecutionRepository

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

## Existing Migrations (migrations/ at repo root)

${context.migrationInventory}

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
}` + '\n\n' + buildConstraintBlock();
  }
}
