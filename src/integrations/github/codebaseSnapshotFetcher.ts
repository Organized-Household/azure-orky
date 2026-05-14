import { createOctokit } from './githubClient';
import { epicFileMap, SNAPSHOT_CHAR_LIMIT } from '../../config/contextConfig';
import { FileOperation } from '../../domain/instructionPacket';
import { RuntimeSnapshotBuilder } from '../snapshot/runtimeSnapshotBuilder';

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
   * When fileOperations are provided (non-empty), uses RuntimeSnapshotBuilder
   * to derive the file list dynamically from the DIP's import graph.
   * Falls back to the static epicFileMap when fileOperations are absent or
   * yield no paths.
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

      if (filePaths.length === 0) {
        warnings.push(
          `RuntimeSnapshotBuilder returned no paths for epic ${epicId} — falling back to epicFileMap`,
        );
        filePaths = epicFileMap[epicId] ?? [];
      }
    } else {
      filePaths = epicFileMap[epicId] ?? [];
    }

    if (filePaths.length === 0) {
      warnings.push(`No file map configured for epic ${epicId} — snapshot skipped`);
      return { files: [], totalChars: 0, warnings };
    }

    const octokit = createOctokit();
    const files: SnapshotFile[] = [];
    let totalChars = 0;

    for (const filePath of filePaths) {
      if (totalChars >= SNAPSHOT_CHAR_LIMIT) {
        warnings.push(`Character budget exhausted — skipping ${filePath}`);
        continue;
      }

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
        const remaining = SNAPSHOT_CHAR_LIMIT - totalChars;
        const truncated = raw.length > remaining;
        const content = truncated ? raw.slice(0, remaining) + '\n// [truncated]' : raw;

        files.push({ path: filePath, content, truncated });
        totalChars += content.length;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          warnings.push(`${filePath} not found on ref ${ref} — skipped`);
        } else {
          warnings.push(`Failed to fetch ${filePath}: ${msg}`);
        }
      }
    }

    return { files, totalChars, warnings };
  }
}
