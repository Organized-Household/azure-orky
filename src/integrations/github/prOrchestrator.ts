import { ExecutionRepository } from '../../db/repositories/executionRepository';
import { AuditLogger } from '../../audit/auditLogger';
import { RepoChangeSetRepository } from '../../db/repositories/repoChangeSetRepository';
import { RepositoryManager } from './repositoryManager';
import { PullRequestManager } from './pullRequestManager';
import { WorkspaceManager } from '../../agents/workspaceManager';
import { ExecutionState } from '../../domain/storyPayload';

export interface PrOrchestratorInput {
  executionId: string;
  storyId: string;
  storyTitle: string;
  branchNameHint: string;
  targetRepository: string;
}

export class PrOrchestrator {
  private executionRepo = new ExecutionRepository();
  private auditLogger = new AuditLogger();
  private changeSetRepo = new RepoChangeSetRepository();
  private repositoryManager = new RepositoryManager();
  private pullRequestManager = new PullRequestManager();
  private workspaceManager = new WorkspaceManager();

  async run(input: PrOrchestratorInput): Promise<void> {
    const { executionId, storyId, storyTitle, branchNameHint, targetRepository } = input;

    const parts = targetRepository.split('/');
    if (parts.length !== 2) {
      throw new Error(
        `PrOrchestrator: targetRepository must be "owner/repo", got: ${targetRepository}`,
      );
    }
    const [repositoryOwner, repositoryName] = parts;

    const changeSet = await this.changeSetRepo.getByExecutionId(executionId);
    if (!changeSet?.workspacePath) {
      throw new Error(`PrOrchestrator: no change set with workspace found for execution ${executionId}`);
    }
    const { workspacePath } = changeSet;

    try {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'pr_orchestrator_started',
        state: 'CHANGES_PREPARED',
        status: 'info',
        message: `Starting branch/commit/PR for ${targetRepository}`,
        metadata: { branchNameHint },
      });

      const { branchName, commitSha, headSha } = this.repositoryManager.createBranchAndCommit(
        workspacePath,
        branchNameHint,
        executionId,
        storyId,
        storyTitle,
      );

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'branch_created_and_committed',
        state: 'CHANGES_PREPARED',
        status: 'info',
        message: `Branch ${branchName} created and pushed (commit ${commitSha.slice(0, 7)})`,
        metadata: { branchName, commitSha },
      });

      const { prUrl, prNumber } = await this.pullRequestManager.openPullRequest(
        repositoryOwner,
        repositoryName,
        branchName,
        storyId,
        storyTitle,
      );

      await this.changeSetRepo.updateBranchAndPr(executionId, branchName, commitSha, prUrl, headSha);

      await this.executionRepo.updateState(executionId, 'PR_CREATED' as ExecutionState);
      await this.executionRepo.releaseLock(storyId);

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'pr_created',
        state: 'PR_CREATED',
        status: 'success',
        message: `Pull request opened: ${prUrl} (PR #${prNumber})`,
        metadata: { prUrl, prNumber, branchName },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'pr_orchestrator_failed',
        state: 'FAILED',
        status: 'error',
        message: `PR orchestration failed: ${reason}`,
      });
      throw error;
    } finally {
      await this.workspaceManager.destroyWorkspace(workspacePath);
    }
  }
}
