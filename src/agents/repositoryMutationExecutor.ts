import { v4 as uuidv4 } from 'uuid';
import { InstructionPacket } from '../domain/instructionPacket';
import { CredentialResolver } from '../services/credentialResolver';
import { ExecutionState } from '../domain/storyPayload';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { AuditLogger } from '../audit/auditLogger';
import { getPool } from '../db/dbClient';
import { ClaudeMutationAgent } from './claudeMutationAgent';
import { WorkspaceManager } from './workspaceManager';
import { ValidationCommandRunner } from './validationCommandRunner';

export class RepositoryMutationExecutor {
  private agent = new ClaudeMutationAgent();
  private workspaceManager = new WorkspaceManager();
  private validationRunner = new ValidationCommandRunner();
  private executionRepo = new ExecutionRepository();
  private logger = new AuditLogger();

  async execute(
    executionId: string,
    storyId: string,
    packet: InstructionPacket,
    projectKey: string,
  ): Promise<void> {
    let workspacePath: string | undefined;

    await this.executionRepo.updateState(executionId, 'AGENT_EXECUTING' as ExecutionState);
    await this.logger.log({
      executionId,
      storyId,
      step: 'mutation_agent_started',
      state: 'AGENT_EXECUTING',
      status: 'info',
      message: `Mutation agent selected: claude. Target repository: ${packet.targetRepository}`,
      metadata: {
        targetRepository: packet.targetRepository,
        baseBranch: packet.baseBranch,
        fileOperationCount: packet.fileOperations.length,
        validationCommandCount: packet.validationCommands.length,
      },
    });

    try {
      const resolver = new CredentialResolver();
      const githubToken = await resolver.resolve(projectKey, 'github_token');
      if (!githubToken) {
        throw new Error(
          `No GitHub token available for project ${projectKey} — set GH_TOKEN env var or seed via /projects/${projectKey}/credentials`,
        );
      }
      const workspace = await this.workspaceManager.createWorkspace(
        packet.targetRepository,
        packet.baseBranch,
        executionId,
        githubToken,
      );
      workspacePath = workspace.workspacePath;

      await this.logger.log({
        executionId,
        storyId,
        step: 'workspace_created',
        state: 'AGENT_EXECUTING',
        status: 'info',
        message: `Workspace created. Repository cloned at base branch: ${packet.baseBranch}`,
      });

      const mutationResult = await this.agent.execute({
        executionId,
        workspacePath,
        instructionPacket: packet,
      });

      if (!mutationResult.success) {
        throw new Error(
          `Mutation agent execution failed: ${mutationResult.error ?? 'unknown error'}`,
        );
      }

      await this.logger.log({
        executionId,
        storyId,
        step: 'mutations_applied',
        state: 'AGENT_EXECUTING',
        status: 'info',
        message: `Mutations applied. ${mutationResult.changedFiles.length} file(s) changed.`,
        metadata: {
          changedFiles: mutationResult.changedFiles,
          diffSummary: mutationResult.diffSummary,
        },
      });

      if (packet.validationCommands.length > 0) {
        const validationResult = this.validationRunner.run(
          packet.validationCommands,
          workspacePath,
        );

        await this.logger.log({
          executionId,
          storyId,
          step: 'validation_commands_run',
          state: 'AGENT_EXECUTING',
          status: validationResult.success ? 'info' : 'error',
          message: validationResult.success
            ? 'All validation commands passed.'
            : `Validation command failed: ${validationResult.failedCommand}`,
          metadata: { validationOutput: validationResult.output.slice(0, 2000) },
        });

        if (!validationResult.success) {
          throw new Error(
            `Validation command failed: ${validationResult.failedCommand}\n${validationResult.output.slice(0, 500)}`,
          );
        }
      }

      const changeSetId = uuidv4();
      const pool = getPool();
      await pool.query(
        `INSERT INTO repo_change_sets
           (change_set_id, execution_id, story_id, workspace_path, changed_files, diff_summary)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          changeSetId,
          executionId,
          storyId,
          workspacePath,
          JSON.stringify(mutationResult.changedFiles),
          mutationResult.diffSummary,
        ],
      );

      await this.executionRepo.updateState(executionId, 'CHANGES_PREPARED' as ExecutionState);
      await this.logger.log({
        executionId,
        storyId,
        step: 'changes_prepared',
        state: 'CHANGES_PREPARED',
        status: 'success',
        message: 'Mutation complete. Workspace ready for branch/commit/PR operations.',
        metadata: { changeSetId, changedFiles: mutationResult.changedFiles },
      });
    } catch (error: unknown) {
      if (workspacePath) {
        await this.workspaceManager.destroyWorkspace(workspacePath);
      }

      const reason = error instanceof Error ? error.message : String(error);
      await this.logger.log({
        executionId,
        storyId,
        step: 'mutation_agent_failed',
        state: 'FAILED',
        status: 'error',
        message: `Mutation agent execution failed: ${reason}`,
      });

      await this.executionRepo.failIfNotTerminal(
        executionId,
        `AGENT_EXECUTING failed: ${reason}`,
      );

      throw error;
    }
  }
}
