import { StoryPayload, EXECUTION_STATES } from '../domain/storyPayload';
import { InstructionPacket } from '../domain/instructionPacket';
import { ForgeClient, ForgeInvocationError } from '../integrations/forge/forgeClient';
import { InstructionValidator } from '../integrations/forge/instructionValidator';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { InstructionPacketRepository } from '../db/repositories/instructionPacketRepository';
import { PacketNegotiationRepository } from '../db/repositories/packetNegotiationRepository';
import { AuditLogger } from '../audit/auditLogger';
import { ExecutionError } from '../domain/executionError';
import { PacketReviewer } from '../integrations/review/packetReviewer';
import { PacketNegotiationOrchestrator } from './packetNegotiationOrchestrator';
import { CodebaseSnapshotFetcher } from '../integrations/github/codebaseSnapshotFetcher';

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
      message: 'Context assembly will occur inside Forge invocation (project context, history, snapshot)',
    });

    await this.executionRepo.updateState(executionId, EXECUTION_STATES.FORGE_INVOKED);
    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'forge_invocation_started',
      state: EXECUTION_STATES.FORGE_INVOKED,
      status: 'started',
      message: 'Invoking Forge to generate instruction packet',
      metadata: { forgePromptVersion: this.forgeClient.promptVersion },
    });

    let packet: InstructionPacket;
    try {
      packet = await this.forgeClient.generateInstructionPacket(executionId, storyId, storyPayload);
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

    // --- EPIC-10: Packet Negotiation Loop ---
    const epicId = storyPayload.PDEEpicID ?? storyPayload.epicId ?? '';

    let codebaseSnapshot = '';
    let snapshotFiles: Array<{ path: string; content: string }> = [];
    try {
      const snapshotFetcher = new CodebaseSnapshotFetcher();
      // Pass packet.fileOperations so the fetcher can build the snapshot
      // dynamically from the DIP's actual import graph (EPIC-12).
      const snapshot = await snapshotFetcher.fetchForEpic(epicId, packet.fileOperations);
      snapshotFiles = snapshot.files;
      if (snapshot.files.length > 0) {
        codebaseSnapshot = snapshot.files
          .map((f) => `#### \`${f.path}\`\n\`\`\`typescript\n${f.content}\n\`\`\``)
          .join('\n\n');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_snapshot_failed',
        state: EXECUTION_STATES.PACKET_RECEIVED,
        status: 'warn',
        message: `Codebase snapshot unavailable for reviewer — proceeding without it: ${message}`,
      });
    }

    const reviewer = new PacketReviewer(this.auditLogger);
    const negotiationRepo = new PacketNegotiationRepository();
    const negotiationOrchestrator = new PacketNegotiationOrchestrator(
      reviewer,
      negotiationRepo,
      this.executionRepo,
      this.auditLogger,
    );

    const forgeRevise = async (issues: string[], currentPacket: InstructionPacket, contextFiles?: Record<string, string>): Promise<InstructionPacket> => {
      return this.forgeClient.revise(executionId, storyId, storyPayload, issues, currentPacket, contextFiles);
    };

    const negotiationResult = await negotiationOrchestrator.negotiate(
      executionId,
      storyId,
      packet,
      codebaseSnapshot,
      forgeRevise,
      snapshotFiles,
    );

    if (!negotiationResult.approved) {
      await this.executionRepo.failIfNotTerminal(executionId, negotiationResult.diagnosticMessage);
      throw new ExecutionError(
        negotiationResult.diagnosticMessage,
        'PACKET_INVALID',
        executionId,
        storyId,
      );
    }

    packet = negotiationResult.finalPacket;
    // --- End EPIC-10 ---

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
