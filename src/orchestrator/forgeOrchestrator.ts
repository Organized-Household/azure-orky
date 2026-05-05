import { StoryPayload, EXECUTION_STATES } from '../domain/storyPayload';
import { InstructionPacket } from '../domain/instructionPacket';
import { ForgeClient, ForgeInvocationError } from '../integrations/forge/forgeClient';
import { InstructionValidator } from '../integrations/forge/instructionValidator';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { InstructionPacketRepository } from '../db/repositories/instructionPacketRepository';
import { AuditLogger } from '../audit/auditLogger';
import { ExecutionError } from '../domain/executionError';

export class ForgeOrchestrator {
  constructor(
    private forgeClient: ForgeClient,
    private validator: InstructionValidator,
    private executionRepo: ExecutionRepository,
    private packetRepo: InstructionPacketRepository,
    private auditLogger: AuditLogger,
  ) {}

  async run(executionId: string, storyPayload: StoryPayload): Promise<InstructionPacket> {
    const storyId = storyPayload.storyId;

    // Stub: artifact resolution pending EPIC-artifact-storage work
    await this.executionRepo.updateState(executionId, EXECUTION_STATES.ARTIFACTS_RESOLVED);
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'artifacts_resolved',
      state: EXECUTION_STATES.ARTIFACTS_RESOLVED,
      status: 'succeeded',
      message: 'PDE artifact resolution complete (stub)',
    });

    await this.executionRepo.updateState(executionId, EXECUTION_STATES.FORGE_INVOKED);
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'forge_invocation_started',
      state: EXECUTION_STATES.FORGE_INVOKED,
      status: 'started',
      message: 'Invoking Forge to generate instruction packet',
    });

    let packet: InstructionPacket;
    try {
      packet = await this.forgeClient.generateInstructionPacket(storyPayload);
    } catch (error) {
      const code = error instanceof ForgeInvocationError ? error.code : 'FORGE_HTTP_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'forge_invocation_failed',
        state: EXECUTION_STATES.FORGE_INVOKED,
        status: 'failed',
        message: `Forge invocation failed: ${message}`,
      });
      await this.executionRepo.failIfNotTerminal(executionId, message);
      throw new ExecutionError(
        `Forge invocation failed: ${message}`,
        code,
        executionId,
        storyId,
        error,
      );
    }

    await this.executionRepo.updateState(executionId, EXECUTION_STATES.PACKET_RECEIVED);
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'forge_invocation_succeeded',
      state: EXECUTION_STATES.PACKET_RECEIVED,
      status: 'succeeded',
      message: `Instruction packet received: ${packet.packetId}`,
    });

    const result = this.validator.validate(packet);

    if (!result.valid) {
      const reason = result.reason ?? 'Instruction packet failed validation';
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'packet_rejected',
        state: EXECUTION_STATES.PACKET_RECEIVED,
        status: 'failed',
        message: reason,
      });
      await this.executionRepo.failIfNotTerminal(executionId, reason);
      throw new ExecutionError(reason, 'PACKET_INVALID', executionId, storyId);
    }

    await this.executionRepo.updateState(executionId, EXECUTION_STATES.PACKET_VALIDATED);
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'packet_validated',
      state: EXECUTION_STATES.PACKET_VALIDATED,
      status: 'succeeded',
      message: `Instruction packet ${packet.packetId} validated`,
    });

    await this.packetRepo.save(executionId, packet);

    return packet;
  }
}
