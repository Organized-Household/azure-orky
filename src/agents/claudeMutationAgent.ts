import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MutationAgentAdapter, MutationAgentInput, MutationResult } from './mutationAgentAdapter';
import { FileOperation } from '../domain/instructionPacket';

interface ResolvedFileOperation {
  path: string;
  content: string;
}

interface ClaudeExecutionResponse {
  fileOperations: ResolvedFileOperation[];
}

export class ClaudeMutationAgent implements MutationAgentAdapter {
  private client: Anthropic;
  private model = 'claude-sonnet-4-5';

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async execute(input: MutationAgentInput): Promise<MutationResult> {
    const { executionId, workspacePath, instructionPacket } = input;

    try {
      const deleteOps = instructionPacket.fileOperations.filter(
        (op) => op.operation === 'delete',
      );
      const writeOps = instructionPacket.fileOperations.filter(
        (op) => op.operation !== 'delete',
      );

      let resolvedOps: ResolvedFileOperation[] = [];
      if (writeOps.length > 0) {
        resolvedOps = await this.resolveWriteOperations(writeOps, workspacePath);
      }

      const changedFiles: string[] = [];
      for (const op of resolvedOps) {
        const absolutePath = path.join(workspacePath, op.path);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, op.content, 'utf-8');
        changedFiles.push(op.path);
      }

      for (const op of deleteOps) {
        const absolutePath = path.join(workspacePath, op.path);
        try {
          await fs.unlink(absolutePath);
          changedFiles.push(op.path);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
      }

      const diffSummary = changedFiles.map((f) => `modified: ${f}`).join('\n');

      return {
        success: true,
        changedFiles,
        diffSummary,
        validationOutput: '',
        error: undefined,
      };
    } catch (error: unknown) {
      return {
        success: false,
        changedFiles: [],
        diffSummary: '',
        validationOutput: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveWriteOperations(
    ops: FileOperation[],
    workspacePath: string,
  ): Promise<ResolvedFileOperation[]> {
    const existingContents: Record<string, string> = {};
    for (const op of ops) {
      if (op.operation === 'modify') {
        const absolutePath = path.join(workspacePath, op.path);
        try {
          existingContents[op.path] = await fs.readFile(absolutePath, 'utf-8');
        } catch {
          existingContents[op.path] = '';
        }
      }
    }

    const prompt = this.buildExecutionPrompt(ops, existingContents);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');

    const cleaned = rawText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

    let parsed: ClaudeExecutionResponse;
    try {
      parsed = JSON.parse(cleaned) as ClaudeExecutionResponse;
    } catch {
      throw new Error(
        `ClaudeMutationAgent: Failed to parse execution response as JSON. Raw response: ${rawText.slice(0, 500)}`,
      );
    }

    if (!Array.isArray(parsed.fileOperations)) {
      throw new Error('ClaudeMutationAgent: Response missing fileOperations array');
    }

    return parsed.fileOperations;
  }

  private buildExecutionPrompt(
    ops: FileOperation[],
    existingContents: Record<string, string>,
  ): string {
    const opsJson = JSON.stringify(ops, null, 2);
    const existingJson = JSON.stringify(existingContents, null, 2);

    return `You are a precise code execution agent. You receive file operation instructions and produce the exact file contents to write to disk.

FILE OPERATIONS TO EXECUTE:
${opsJson}

EXISTING FILE CONTENTS (for modify operations):
${existingJson}

INSTRUCTIONS:
- For each "create" operation: produce the complete file content as specified.
- For each "modify" operation: apply the described changes to the existing content and produce the complete updated file.
- For each "replace" operation: produce the complete replacement file content as specified.
- Do NOT change any logic, add commentary, or deviate from the instructions.
- Do NOT include the "delete" operations in your response — those are handled separately.

Respond with ONLY a valid JSON object in this exact shape. No markdown. No explanation. No code fences. Just JSON:

{
  "fileOperations": [
    {
      "path": "<relative file path>",
      "content": "<complete file content>"
    }
  ]
}`;
  }
}
