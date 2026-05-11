import { Octokit } from '@octokit/rest';
import { AuditLogger } from '../../audit/auditLogger';

export interface MergeResult {
  mergeSha: string;
}

export class MergeController {
  constructor(
    private readonly octokit: Octokit,
    private readonly auditLogger: AuditLogger,
  ) {}

  async merge(params: {
    executionId: string;
    storyId: string;
    owner: string;
    repo: string;
    pullNumber: number;
    expectedHeadSha: string;
  }): Promise<MergeResult> {
    const { executionId, storyId, owner, repo, pullNumber, expectedHeadSha } = params;

    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    if (pr.state !== 'open') {
      throw new Error(`PR #${pullNumber} is not open (state: ${pr.state}). Cannot merge.`);
    }

    if (pr.mergeable === false) {
      throw new Error(
        `PR #${pullNumber} is not mergeable (conflicts or branch protection). Cannot merge.`,
      );
    }

    const currentHeadSha = pr.head.sha;
    if (currentHeadSha !== expectedHeadSha) {
      throw new Error(
        `PR #${pullNumber} head SHA changed. Expected ${expectedHeadSha.slice(0, 7)}, found ${currentHeadSha.slice(0, 7)}. Aborting merge for safety.`,
      );
    }

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'merge_started',
      state: 'CI_PASSED',
      status: 'info',
      message: `Merging PR #${pullNumber} (head: ${currentHeadSha.slice(0, 7)})`,
    });

    const { data: mergeData } = await this.octokit.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: 'squash',
      commit_title: `[Orky] PR #${pullNumber} auto-merged`,
    });

    if (!mergeData.merged) {
      throw new Error(
        `GitHub merge API returned merged=false for PR #${pullNumber}. Message: ${mergeData.message}`,
      );
    }

    const mergeSha = mergeData.sha;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'merge_succeeded',
      state: 'CI_PASSED',
      status: 'success',
      message: `PR #${pullNumber} merged. Merge SHA: ${mergeSha}`,
    });

    return { mergeSha };
  }
}
