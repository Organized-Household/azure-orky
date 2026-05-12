import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogger } from '../../audit/auditLogger';

export interface BatchedDIPRequest {
  batchExecutionId: string;
  epicId: string;
  storyIds: string[];
  stories: Array<{
    storyId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    jiraIssueKey: string;
  }>;
  baPack: string;
  developerExecutionPacket: string;
  engineeringSpec: string;
  manifest: string;
  productDesignDocument: string;
  productIntentBrief: string;
  qaPacket: string;
  systemArch: string;
  implementationHistory: string;
  codebaseSnapshot: string;
}

export interface BatchedDIP {
  packetId: string;
  storyIds: string[];
  targetRepository: string;
  baseBranch: string;
  branchNameHint: string;
  fileOperations: Array<{
    operation: 'create' | 'modify' | 'replace' | 'delete';
    path: string;
    content?: string;
  }>;
  validationCommands: string[];
  prTitle: string;
  prBody: string;
  commitMessage: string;
  implementationSummary: string;
  jiraLinkage: string;
}

export class BatchedForgeClient {
  private client: Anthropic;
  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    this.client = new Anthropic({ apiKey });
    this.auditLogger = auditLogger;
  }

  async generateBatchedDIP(request: BatchedDIPRequest): Promise<BatchedDIP> {
    const requestId = uuidv4();
    
    await this.auditLogger.log({
      executionId: request.batchExecutionId,
      storyId: request.storyIds.join(','),
      step: 'BATCHED_DIP_GENERATION',
      state: 'FORGE_INVOKED',
      status: 'IN_PROGRESS',
      message: `Invoking Forge for batched DIP with ${request.storyIds.length} stories`,
      metadata: { requestId, storyIds: request.storyIds }
    });

    const prompt = this.buildBatchedDIPPrompt(request);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 200000,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Forge response was not text');
      }

      const dip = this.parseBatchedDIPResponse(content.text, request.storyIds);

      await this.auditLogger.log({
        executionId: request.batchExecutionId,
        storyId: request.storyIds.join(','),
        step: 'BATCHED_DIP_GENERATION',
        state: 'PACKET_RECEIVED',
        status: 'SUCCESS',
        message: `Batched DIP generated successfully: ${dip.packetId}`,
        metadata: { packetId: dip.packetId, fileOperationCount: dip.fileOperations.length }
      });

      return dip;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.auditLogger.log({
        executionId: request.batchExecutionId,
        storyId: request.storyIds.join(','),
        step: 'BATCHED_DIP_GENERATION',
        state: 'FORGE_INVOKED',
        status: 'FAILED',
        message: `Batched DIP generation failed: ${error.message}`,
        metadata: { error: error.message, requestId }
      });
      throw error;
    }
  }

  private buildBatchedDIPPrompt(request: BatchedDIPRequest): string {
    const storySection = request.stories.map((story, index) => {
      return `### Story ${index + 1}: ${story.jiraIssueKey} — ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria}
`;
    }).join('\n---\n\n');

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
- Logging: console.log() and console.error() only — never import a logger library
- Forge is invoked via @anthropic-ai/sdk (already installed) — never via fetch(), axios, or any HTTP client
- Never create or modify src/config/env.ts — read env vars directly with process.env
- Never add required env var checks that would block startup
- No new model files in src/db/models/ unless the story explicitly requires a TypeScript interface for a new table
- All new DB repositories follow the pattern in src/db/repositories/executionRepository.ts: getPool(), $1/$2 params, catch (err: unknown)
- Claude API model string must be exactly 'claude-sonnet-4-5'
- Never import from a module that does not appear in the codebase snapshot or in fileOperations of this DIP
- StoryPayload fields: storyId (string), title (string), description (string), acceptanceCriteria (string), jiraIssueKey (string), PDEStoryID (string), PDEEpicID (string | undefined)
- If a fileOperation creates a DB repository that queries a table, fileOperations MUST also include the migration SQL file for that table
- Migration files MUST be placed at migrations/<NNN>_description.sql at the repo root — NEVER inside src/ or any subdirectory
- Migration numbering: use the next sequential number after the highest existing migration
- If a table already exists in the migration inventory, do NOT create it again — add an ALTER TABLE migration instead
- AuditLogger.log() signature: { executionId: string, storyId: string, step: string, state: string, status: string, message?: string, metadata?: unknown } — executionId and storyId are never null, use '' if not applicable; metadata takes an object (not a JSON string); there is no timestamp field
- Project context artifacts are fetched via ProjectContextRepository.getAll() in src/db/repositories/projectContextRepository.ts

## Project Context (PDE Artifacts)

### BA_PACK
${request.baPack}

### DEVELOPER_EXECUTION_PACKET
${request.developerExecutionPacket}

### ENGINEERING_SPEC
${request.engineeringSpec}

### MANIFEST
${request.manifest}

### PRODUCT_DESIGN_DOCUMENT
${request.productDesignDocument}

### PRODUCT_INTENT_BRIEF
${request.productIntentBrief}

### QA_PACKET
${request.qaPacket}

### SYSTEM_ARCH
${request.systemArch}

---

## Implementation History (Last 5 decisions)

${request.implementationHistory}

---

## Current Codebase

${request.codebaseSnapshot}

---

## Stories to Implement (Batched DIP)

This DIP must cover ALL of the following stories in a single unified implementation:

${storySection}

---

## Required Output

Return ONLY a single valid JSON object. No markdown fences. No explanation. No text outside the JSON.

Schema:
{
  "packetId": "<uuid>",
  "storyIds": ${JSON.stringify(request.storyIds)},
  "targetRepository": "orkyai25-ctrl/orky",
  "baseBranch": "dev",
  "branchNameHint": "<kebab-case hint covering all stories>",
  "fileOperations": [
    {
      "operation": "create|modify|replace|delete",
      "path": "<repo-relative path>",
      "content": "<full file content for create/modify/replace>"
    }
  ],
  "validationCommands": [],
  "prTitle": "<concise PR title: [Orky] EPIC-${request.epicId}: Story A + Story B>",
  "prBody": "<full markdown PR description: What this does / Files created/modified / Acceptance criteria covered / Closes ${request.storyIds.join(', Closes ')}>",
  "commitMessage": "<conventional commit: feat(${request.storyIds.join('+')}): description>",
  "implementationSummary": "<human-readable summary of what was built and why, for the decision log>",
  "jiraLinkage": "${request.storyIds.join(', ')}"
}
`;
  }

  private parseBatchedDIPResponse(responseText: string, expectedStoryIds: string[]): BatchedDIP {
    let parsed: unknown;
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to parse Forge batched DIP response: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Forge batched DIP response is not a valid object');
    }

    const dip = parsed as Record<string, unknown>;

    if (typeof dip.packetId !== 'string' || !dip.packetId) {
      throw new Error('Batched DIP missing valid packetId');
    }
    if (!Array.isArray(dip.storyIds) || dip.storyIds.length === 0) {
      throw new Error('Batched DIP missing storyIds array');
    }
    if (typeof dip.targetRepository !== 'string') {
      throw new Error('Batched DIP missing targetRepository');
    }
    if (typeof dip.baseBranch !== 'string') {
      throw new Error('Batched DIP missing baseBranch');
    }
    if (typeof dip.branchNameHint !== 'string') {
      throw new Error('Batched DIP missing branchNameHint');
    }
    if (!Array.isArray(dip.fileOperations)) {
      throw new Error('Batched DIP missing fileOperations array');
    }
    if (!Array.isArray(dip.validationCommands)) {
      throw new Error('Batched DIP missing validationCommands array');
    }
    if (typeof dip.prTitle !== 'string') {
      throw new Error('Batched DIP missing prTitle');
    }
    if (typeof dip.prBody !== 'string') {
      throw new Error('Batched DIP missing prBody');
    }
    if (typeof dip.commitMessage !== 'string') {
      throw new Error('Batched DIP missing commitMessage');
    }
    if (typeof dip.implementationSummary !== 'string') {
      throw new Error('Batched DIP missing implementationSummary');
    }
    if (typeof dip.jiraLinkage !== 'string') {
      throw new Error('Batched DIP missing jiraLinkage');
    }

    const returnedStoryIds = dip.storyIds as string[];
    const expectedSet = new Set(expectedStoryIds);
    const returnedSet = new Set(returnedStoryIds);

    if (returnedStoryIds.length !== expectedStoryIds.length || 
        !returnedStoryIds.every(id => expectedSet.has(id)) ||
        !expectedStoryIds.every(id => returnedSet.has(id))) {
      throw new Error(`Batched DIP storyIds mismatch. Expected: ${expectedStoryIds.join(',')}, Got: ${returnedStoryIds.join(',')}`);
    }

    return dip as BatchedDIP;
  }
}
