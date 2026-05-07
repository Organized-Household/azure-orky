import { getPool } from '../dbClient';
import { InstructionPacket } from '../../domain/instructionPacket';

export class InstructionPacketRepository {
  async save(executionId: string, packet: InstructionPacket): Promise<void> {
    const pool = getPool();

    await pool.query(
      `INSERT INTO instruction_packets (
        packet_id, execution_id, story_id, target_repository,
        base_branch, branch_name_hint, file_operations, validation_commands
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        packet.packetId,
        executionId,
        packet.storyId,
        packet.targetRepository,
        packet.baseBranch,
        packet.branchNameHint,
        JSON.stringify(packet.fileOperations),
        JSON.stringify(packet.validationCommands),
      ]
    );
  }
}
