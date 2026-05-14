import { createOctokit } from './githubClient';
import { SNAPSHOT_CHAR_LIMIT } from '../../config/contextConfig';
import { FileOperation } from '../../domain/instructionPacket';
import { RuntimeSnapshotBuilder } from '../snapshot/runtimeSnapshotBuilder';
import { SnapshotBudgetManager } from '../snapshot/snapshotBudgetManager';

export interface SnapshotFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface CodebaseSnapshot {
  files: SnapshotFile[];
  totalChars: number;
  warnings: string[];
}

export class CodebaseSnapshotFetcher {
  private readonly owner: string;
  private readonly repo: string;

  constructor() {
    const owner = process.env.GITHUB_REPOSITORY_OWNER;
    if (!owner) throw new Error('GITHUB_REPOSITORY_OWNER is not set');
    this.owner = owner;
    this.repo = process.env.GITHUB_TARGET_REPO ?? 'orky';
  }

  /**
   * Fetches source files for the given epic from GitHub Contents API.
   *
   * fileOperations must be provided: RuntimeSnapshotBuilder derives the file
   * list dynamically from the DIP's import graph. Returns an empty snapshot
   * (with a warning) when fileOperations are absent or yield no paths.
   *
   * Non-fatal: if the entire fetch fails, returns an empty snapshot with a warning.
   * Files that do not exist on the branch are skipped with a warning, not a fatal error.
   * Total content is capped at SNAPSHOT_CHAR_LIMIT characters.
   */
  async fetchForEpic(
    epicId: string,
    fileOperations?: FileOperation[],
    ref: string = 'dev',
  ): Promise<CodebaseSnapshot> {
    const warnings: string[] = [];
    let filePaths: string[];

    if (fileOperations && fileOperations.length > 0) {
      const builder = new RuntimeSnapshotBuilder();
      const result = await builder.buildFileList(fileOperations);
      warnings.push(...result.warnings);
      filePaths = result.filePaths;
    } else {
      filePaths = [];
    }

    if (filePaths.length === 0) {
      warnings.push(
        `No runtime file paths resolved for epic ${epicId} — snapshot skipped (fileOperations: ${fileOperations?.length ?? 0})`,
      );
      return { files: [], totalChars: 0, warnings };
    }

    const octokit = createOctokit();
    const rawFiles: Array<{ path: string; content: string }> = [];

    // Fetch raw content for all candidate files (no truncation yet)
    for (const filePath of filePaths) {
      try {
        const response = await octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: filePath,
          ref,
        });

        const data = response.data;
        if (Array.isArray(data) || data.type !== 'file') {
          warnings.push(`${filePath} is not a file — skipped`);
          continue;
        }

        const raw = Buffer.from(data.content, 'base64').toString('utf-8');
        rawFiles.push({ path: filePath, content: raw });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          warnings.push(`${filePath} not found on ref ${ref} — skipped`);
        } else {
          warnings.push(`Failed to fetch ${filePath}: ${msg}`);
        }
      }
    }

    // Apply smart budget allocation (interfaces first, implementations second)
    const budgetManager = new SnapshotBudgetManager();
    const allocated = budgetManager.allocate(rawFiles, SNAPSHOT_CHAR_LIMIT);

    const files: SnapshotFile[] = allocated.map((f) => ({
      path: f.path,
      content: f.content,
      truncated: f.truncated,
    }));
    const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);

    return { files, totalChars, warnings };
  }
}
