import { getPool } from '../dbClient';
import { InstructionPacket } from '../../domain/instructionPacket';
import { FORGE_PROMPT_VERSION } from '../../integrations/forge/forgeConstraints';

export class InstructionPacketRepository {
  async getTargetRepositoryByExecutionId(executionId: string): Promise<string | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT target_repository AS "targetRepository"
       FROM instruction_packets
       WHERE execution_id = $1
       LIMIT 1`,
      [executionId],
    );
    return result.rows[0]?.targetRepository ?? null;
  }

  async save(executionId: string, packet: InstructionPacket): Promise<void> {
    const pool = getPool();

    await pool.query(
      `INSERT INTO instruction_packets (
        packet_id, execution_id, story_id, target_repository,
        base_branch, branch_name_hint, file_operations, validation_commands,
        received_at, pr_title, pr_body, commit_message, implementation_summary, jira_linkage,
        forge_prompt_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13, $14)`,
      [
        packet.packetId,
        executionId,
        packet.storyId,
        packet.targetRepository,
        packet.baseBranch,
        packet.branchNameHint,
        JSON.stringify(packet.fileOperations),
        JSON.stringify(packet.validationCommands),
        packet.prTitle,
        packet.prBody,
        packet.commitMessage,
        packet.implementationSummary,
        packet.jiraLinkage,
        FORGE_PROMPT_VERSION,
      ],
    );
  }
}
