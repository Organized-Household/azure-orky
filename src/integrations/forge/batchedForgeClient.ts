import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogger } from '../../audit/auditLogger';
import { InstructionPacket } from '../../domain/instructionPacket';
import { StoryPayload } from '../../domain/storyPayload';
import { createOctokit } from '../github/githubClient';

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
  projectContext: string;
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
  // ORKY-93: Expose last fetched snapshot files so BatchOrchestrator can pass
  // them to PacketNegotiationOrchestrator without fetching twice.
  private lastSnapshotFiles: Array<{ path: string; content: string }> = [];

  constructor(private auditLogger: AuditLogger) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // ORKY-93: Returns snapshot files from the most recent generateBatchedDIP call.
  getLastSnapshotFiles(): Array<{ path: string; content: string }> {
    return this.lastSnapshotFiles;
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
      metadata: { requestId, storyIds: request.storyIds },
    });

    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER ?? 'unknown-owner';
    const repoName = process.env.GITHUB_TARGET_REPO ?? 'orky';
    let currentFileContents = '_File content fetch skipped._';
    // ORKY-93: Reset snapshot files before each generation call.
    this.lastSnapshotFiles = [];
    try {
      const { contents, snapshotFiles } = await this.fetchCurrentFileContentsWithSnapshot(
        request.stories,
        repoOwner,
        repoName,
      );
      currentFileContents = contents;
      this.lastSnapshotFiles = snapshotFiles;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[BatchedForgeClient] fetchCurrentFileContents failed: ${msg} — proceeding without file contents`);
    }
    const prompt = this.buildBatchedDIPPrompt(request, currentFileContents, repoName);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
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
        status: 'success',
        message: `Batched DIP generated successfully: ${dip.packetId}`,
        metadata: { packetId: dip.packetId, fileOperationCount: dip.fileOperations.length },
      });

      return dip;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.auditLogger.log({
        executionId: request.batchExecutionId,
        storyId: request.storyIds.join(','),
        step: 'BATCHED_DIP_GENERATION',
        state: 'FORGE_INVOKED',
        status: 'error',
        message: `Batched DIP generation failed: ${error.message}`,
        metadata: { error: error.message, requestId },
      });
      throw error;
    }
  }

  // ORKY-93: Revision method for PacketNegotiationOrchestrator forgeRevise callback.
  // Uses the same direct Anthropic SDK pattern as generateBatchedDIP — migration to
  // AnthropicRetryClient is ORKY-82 (separate story, out of scope here).
  async revise(
    executionId: string,
    storyId: string,
    dipStories: StoryPayload[],
    issues: string[],
    currentPacket: InstructionPacket,
    contextFiles?: Record<string, string>,
  ): Promise<InstructionPacket> {
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'BATCHED_DIP_REVISION',
      state: 'NEGOTIATING',
      status: 'IN_PROGRESS',
      message: `Requesting Forge revision with ${issues.length} issue(s)`,
      metadata: { issueCount: issues.length },
    });

    const contextSection =
      contextFiles && Object.keys(contextFiles).length > 0
        ? `\n\n## Context Files for This Revision\n` +
          Object.entries(contextFiles)
            .map(([path, content]) => `### ${path}\n\`\`\`typescript\n${content}\n\`\`\``)
            .join('\n\n')
        : '';

    const issueList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');

    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER ?? 'unknown-owner';
    const repoName = process.env.GITHUB_TARGET_REPO ?? 'orky';

    const prompt =
      `You are Forge, Senior SaaS Engineer implementing Orky.\n\n` +
      `You previously generated a Developer Instruction Packet (DIP) that was reviewed and rejected.\n` +
      `You must produce a revised DIP that addresses ALL of the following issues.\n\n` +
      `## Issues to Fix\n${issueList}\n\n` +
      `## Current DIP (to revise)\n` +
      `\`\`\`json\n${JSON.stringify(currentPacket, null, 2)}\n\`\`\`` +
      contextSection +
      `\n\n## Hard Constraints — Never Violate\n` +
      `- getPool() from src/db/dbClient.ts — never new Pool()\n` +
      `- FileOperation.path not .filePath\n` +
      `- All PRs target dev branch, never main\n` +
      `- GH_TOKEN env var — never GITHUB_TOKEN\n` +
      `- catch (err: unknown) with explicit narrowing — never catch (err: any)\n` +
      `- validationCommands: always []\n` +
      `- No new npm packages without Architect approval\n` +
      `- Never log GH_TOKEN, ANTHROPIC_API_KEY, or any credential\n` +
      `- Claude API model string must be exactly 'claude-sonnet-4-5'\n` +
      `- Never replace an entire file when a targeted modify operation suffices\n\n` +
      `## Stories Covered by This DIP\n` +
      dipStories.map((s) => `- ${s.jiraIssueKey}: ${s.title}`).join('\n') +
      `\n\n## Required Output\n` +
      `Return ONLY a single valid JSON object matching the original DIP schema. ` +
      `No markdown fences. No explanation. No text outside the JSON.\n\n` +
      `The revised DIP must:\n` +
      `- Keep packetId: "${currentPacket.packetId}"\n` +
      `- Keep storyId: "${currentPacket.storyId}"\n` +
      `- Keep targetRepository: "${repoOwner}/${repoName}"\n` +
      `- Keep baseBranch: "${currentPacket.baseBranch}"\n` +
      `- Fix all listed issues in fileOperations`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseContent = response.content[0];
      if (responseContent.type !== 'text') {
        throw new Error('Forge revision response was not text');
      }

      let parsed: unknown;
      try {
        const stripped = responseContent.text
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        const start = stripped.indexOf('{');
        const end = stripped.lastIndexOf('}');
        const cleaned = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
        parsed = JSON.parse(cleaned);
      } catch (parseErr: unknown) {
        const parseError = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
        throw new Error(`Failed to parse Forge revision response: ${parseError.message}`);
      }

      const revisedPacket = parsed as InstructionPacket;

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'BATCHED_DIP_REVISION',
        state: 'NEGOTIATING',
        status: 'success',
        message: `Forge revision received for packet ${revisedPacket.packetId}`,
        metadata: { packetId: revisedPacket.packetId },
      });

      return revisedPacket;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'BATCHED_DIP_REVISION',
        state: 'NEGOTIATING',
        status: 'error',
        message: `Forge revision failed: ${error.message}`,
        metadata: { error: error.message },
      });
      throw error;
    }
  }

  private buildBatchedDIPPrompt(
    request: BatchedDIPRequest,
    currentFileContents: string = '_Not fetched._',
    repoName: string = 'orky',
  ): string {
    const storySection = request.stories
      .map(
        (story, index) => `### Story ${index + 1}: ${story.jiraIssueKey} — ${story.title}\n\n**Description:**\n${story.description}\n\n**Acceptance Criteria:**\n${story.acceptanceCriteria}\n`,
      )
      .join('\n---\n\n');

    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER ?? 'unknown-owner';

    return `You are Forge, Senior SaaS Engineer implementing Orky, the AI-Orchestrated SaaS Engineering System.\n\nYou implement specifications exactly as written. You write safe, production-quality Developer Instruction Packets (DIPs) for Claude Code to execute.\n\n## Tech Stack\n- Node.js + TypeScript, Supabase PostgreSQL, Railway Container (node:22-alpine)\n- GitHub repo: ${repoOwner}/orky, default branch: dev\n- pg driver — $1/$2 positional params only. Never named params.\n\n## Hard Constraints — Never Violate\n- getPool() from src/db/dbClient.ts — never new Pool()\n- FileOperation.path not .filePath\n- All PRs target dev branch, never main\n- GH_TOKEN env var — never GITHUB_TOKEN\n- Constructor pattern: positional args — never a deps object\n- catch (err: unknown) with explicit narrowing — never catch (err: any)\n- validationCommands: always []\n- storyPayload.title not .summary\n- No new npm packages without Architect approval\n- No standalone services — integrate into existing src/ module structure\n- Never log GH_TOKEN, ANTHROPIC_API_KEY, or any credential\n- Logging: console.log() and console.error() only — never import a logger library (no winston, pino, bunyan, utils/logger, or any logger module)\n- Forge is invoked via @anthropic-ai/sdk (already installed) — never via fetch(), axios, or any HTTP client\n- Never create or modify src/config/env.ts — read env vars directly with process.env\n- Never add required env var checks that would block startup — new env vars must have safe defaults or be optional\n- No new model files in src/db/models/ unless the story explicitly requires a TypeScript interface for a new table\n- All new DB repositories follow the pattern in src/db/repositories/executionRepository.ts: getPool(), $1/$2 params, catch (err: unknown)\n- Claude API model string must be exactly 'claude-sonnet-4-5' — never any other model identifier\n- Never import from a module that does not appear in the codebase snapshot or in fileOperations of this DIP — if a dependency does not exist, create it in fileOperations or use an existing module\n- StoryPayload fields: storyId (string), title (string), description (string), acceptanceCriteria (string — NOT string[]), jiraIssueKey (string), PDEStoryID (string), PDEEpicID (string | undefined)\n- If a fileOperation creates a DB repository that queries a table, fileOperations MUST also include the migration SQL file for that table\n- Migration files MUST be placed at migrations/<NNN>_description.sql at the repo root — NEVER inside src/ or any subdirectory\n- Migration numbering: use the next sequential number after the highest existing migration\n- If a table already exists in the migration inventory, do NOT create it again — add an ALTER TABLE migration instead\n- AuditLogger.log() signature: { executionId: string, storyId: string, step: string, state: string, status: string, message?: string, metadata?: unknown } — executionId and storyId are never null, use '' if not applicable; metadata takes an object (not a JSON string); there is no timestamp field\n- Project context artifacts are fetched via ProjectContextRepository.getByProjectKey(storyPayload.projectKey) — never getAll(), never invent an ArtifactResolver\n\n---\n\n## Project Context (PDE Artifacts)\n\n${request.projectContext}\n\n---\n\n## Implementation History (Last 5 decisions)\n\n${request.implementationHistory}\n\n---\n\n## Current Codebase\n\n${request.codebaseSnapshot}\n\n---\n\n## Current File Contents\nThe following shows the EXACT current content of files mentioned in the stories above.\nWhen generating fileOperations for these files, you MUST produce targeted modify operations\nthat preserve the existing structure. NEVER replace an entire file when a targeted change suffices.\n\n${currentFileContents}\n\n---\n\n## Stories to Implement (Batched DIP)\n\nThis DIP must cover ALL of the following stories in a single unified implementation:\n\n${storySection}\n\n---\n\n## Required Output\n\nReturn ONLY a single valid JSON object. No markdown fences. No explanation. No text outside the JSON.\n\nSchema:\n{\n  "packetId": "<uuid>",\n  "storyIds": ${JSON.stringify(request.storyIds)},\n  "targetRepository": "${repoOwner}/${repoName}",\n  "baseBranch": "dev",\n  "branchNameHint": "<kebab-case hint covering all stories>",\n  "fileOperations": [\n    {\n      "operation": "create|modify|replace|delete",\n      "path": "<repo-relative path>",\n      "content": "<full file content for create/modify/replace>"\n    }\n  ],\n  "validationCommands": [],\n  "prTitle": "<concise PR title: [Orky] EPIC-${request.epicId}: Story A + Story B>",\n  "prBody": "<full markdown PR description: What this does / Files created/modified / Acceptance criteria covered / Closes ${request.storyIds.join(', Closes ')}>",\n  "commitMessage": "<conventional commit: feat(${request.storyIds.join('+')}): description>",\n  "implementationSummary": "<human-readable summary of what was built and why, for the decision log>",\n  "jiraLinkage": "${request.storyIds.join(', ')}"\n}`;
  }

  // ORKY-93: Returns both the formatted string for the prompt AND the structured
  // snapshotFiles array for PacketNegotiationOrchestrator — avoids a double fetch.
  private async fetchCurrentFileContentsWithSnapshot(
    stories: BatchedDIPRequest['stories'],
    repoOwner: string,
    repoName: string,
  ): Promise<{ contents: string; snapshotFiles: Array<{ path: string; content: string }> }> {
    const allText = stories
      .map((s) => `${s.description} ${s.acceptanceCriteria}`)
      .join(' ');

    const filePathRegex = /\b(src\/[\w/.-]+\.ts|migrations\/[\w/.-]+\.sql)\b/g;
    const matches = [...allText.matchAll(filePathRegex)];
    const uniquePaths = [...new Set(matches.map((m) => m[1]))];

    if (uniquePaths.length === 0) {
      return {
        contents: '_No existing file paths detected in story descriptions._',
        snapshotFiles: [],
      };
    }

    const sections: string[] = [];
    const snapshotFiles: Array<{ path: string; content: string }> = [];
    let octokit: ReturnType<typeof createOctokit>;
    try {
      octokit = createOctokit();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        contents: `_Could not initialise GitHub client to fetch file contents: ${msg}_`,
        snapshotFiles: [],
      };
    }

    for (const filePath of uniquePaths) {
      try {
        const response = await octokit.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path: filePath,
          ref: 'dev',
        });
        const data = response.data;
        if (Array.isArray(data) || data.type !== 'file') {
          sections.push(`### ${filePath}\n_(directory or non-file — skipped)_`);
          continue;
        }
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        sections.push(`### ${filePath}\n\`\`\`typescript\n${content}\n\`\`\``);
        snapshotFiles.push({ path: filePath, content });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          sections.push(`### ${filePath}\n_(new file — does not exist yet)_`);
        } else {
          sections.push(`### ${filePath}\n_(fetch failed: ${msg} — treat as unknown)_`);
        }
      }
    }

    return { contents: sections.join('\n\n'), snapshotFiles };
  }

  private parseBatchedDIPResponse(responseText: string, expectedStoryIds: string[]): BatchedDIP {
    let parsed: unknown;
    try {
      const stripped = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      const cleaned = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
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

    if (
      returnedStoryIds.length !== expectedStoryIds.length ||
      !returnedStoryIds.every((id) => expectedSet.has(id)) ||
      !expectedStoryIds.every((id) => returnedSet.has(id))
    ) {
      throw new Error(
        `Batched DIP storyIds mismatch. Expected: ${expectedStoryIds.join(',')}, Got: ${returnedStoryIds.join(',')}`,
      );
    }

    return dip as unknown as BatchedDIP;
  }
}
