import { execSync, ExecSyncOptionsWithBufferEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const execOptions: ExecSyncOptionsWithBufferEncoding = {
  encoding: 'buffer',
  stdio: ['pipe', 'pipe', 'pipe'],
};

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { ...execOptions, cwd }).toString('utf8').trim();
}

export interface BranchCommitResult {
  branchName: string;
  commitSha: string;
  headSha: string;
}

export class RepositoryManager {
  createBranchAndCommit(
    workspacePath: string,
    branchNameHint: string,
    executionId: string,
    storyId: string,
    storyTitle: string,
  ): BranchCommitResult {
    const sanitized = branchNameHint
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const branchName = `feat/${sanitized}-${executionId.slice(0, 8)}`;

    exec('git config user.email "orky-bot@orkyai25.com"', workspacePath);
    exec('git config user.name "Orky Bot"', workspacePath);
    exec(`git checkout -b ${branchName}`, workspacePath);
    exec('git add -A', workspacePath);

    const commitMsgFile = path.join(workspacePath, '.git', 'ORKY_COMMIT_MSG');
    const commitBody = [
      `feat: ${storyTitle.replace(/\r?\n/g, ' ').slice(0, 72)}`,
      '',
      `Automated commit by Orky for story ${storyId}`,
    ].join('\n');
    fs.writeFileSync(commitMsgFile, commitBody, 'utf8');
    exec('git commit -F .git/ORKY_COMMIT_MSG', workspacePath);

    const commitSha = exec('git rev-parse HEAD', workspacePath);
    const headSha = commitSha;

    exec(`git push origin ${branchName}`, workspacePath);

    return { branchName, commitSha, headSha };
  }
}
