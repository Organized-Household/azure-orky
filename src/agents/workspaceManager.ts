import { execSync, ExecSyncOptionsWithBufferEncoding } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface WorkspaceInfo {
  workspacePath: string;
  repositoryOwner: string;
  repositoryName: string;
}

const execOptions: ExecSyncOptionsWithBufferEncoding = {
  encoding: 'buffer',
  stdio: ['pipe', 'pipe', 'pipe'],
};

export class WorkspaceManager {
  async createWorkspace(
    targetRepository: string,
    baseBranch: string,
    executionId: string,
    githubToken: string,
  ): Promise<WorkspaceInfo> {
    const parts = targetRepository.split('/');
    if (parts.length !== 2) {
      throw new Error(
        `WorkspaceManager: targetRepository must be in "owner/repo" format, got: ${targetRepository}`,
      );
    }
    const [repositoryOwner, repositoryName] = parts;

    const tmpBase = os.tmpdir();
    const workspacePath = path.join(tmpBase, `orky-workspace-${executionId}`);

    const cloneUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;

    try {
      execSync(
        `git clone --depth=1 --branch ${baseBranch} ${cloneUrl} ${workspacePath}`,
        execOptions,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `WorkspaceManager: Failed to clone repository ${repositoryOwner}/${repositoryName}: ${msg.replace(githubToken, '[REDACTED]')}`,
      );
    }

    return { workspacePath, repositoryOwner, repositoryName };
  }

  async destroyWorkspace(workspacePath: string): Promise<void> {
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      console.warn(`WorkspaceManager: Failed to clean up workspace at ${workspacePath}`);
    }
  }
}
