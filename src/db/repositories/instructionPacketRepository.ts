import sql from 'mssql';
import { getDbPool } from '../dbClient';
import { InstructionPacket } from '../../domain/instructionPacket';

export class InstructionPacketRepository {
  async save(executionId: string, packet: InstructionPacket): Promise<void> {
    const pool = await getDbPool();

    await pool
      .request()
      .input('packetId', sql.NVarChar(36), packet.packetId)
      .input('executionId', sql.UniqueIdentifier, executionId)
      .input('storyId', sql.NVarChar(100), packet.storyId)
      .input('targetRepository', sql.NVarChar(255), packet.targetRepository)
      .input('baseBranch', sql.NVarChar(255), packet.baseBranch)
      .input('branchNameHint', sql.NVarChar(255), packet.branchNameHint)
      .input('fileOperations', sql.NVarChar(sql.MAX), JSON.stringify(packet.fileOperations))
      .input('validationCommands', sql.NVarChar(sql.MAX), JSON.stringify(packet.validationCommands))
      .query(`
        INSERT INTO instruction_packets (
          packetId,
          executionId,
          storyId,
          targetRepository,
          baseBranch,
          branchNameHint,
          fileOperations,
          validationCommands
        )
        VALUES (
          @packetId,
          @executionId,
          @storyId,
          @targetRepository,
          @baseBranch,
          @branchNameHint,
          @fileOperations,
          @validationCommands
        )
      `);
  }
}
