import { InstructionPacket } from '../domain/instructionPacket';
import { AuditLogger } from '../audit/auditLogger';
import { PacketReviewer } from '../integrations/review/packetReviewer';
import { PacketNegotiationRepository } from '../db/repositories/packetNegotiationRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';

const MAX_ROUNDS = 3;

export interface NegotiationResult {
  approved: boolean;
  finalPacket: InstructionPacket;
  roundsCompleted: number;
  diagnosticMessage: string;
}

export class PacketNegotiationOrchestrator {
  constructor(
    private reviewer: PacketReviewer,
    private negotiationRepository: PacketNegotiationRepository,
    private executionRepository: ExecutionRepository,
    private auditLogger: AuditLogger,
  ) {}

  async negotiate(
    executionId: string,
    storyId: string,
    initialPacket: InstructionPacket,
    codebaseSnapshot: string,
    forgeRevise: (issues: string[]) => Promise<InstructionPacket>,
  ): Promise<NegotiationResult> {
    await this.executionRepository.updateState(executionId, 'NEGOTIATING');

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'negotiation_started',
      state: 'NEGOTIATING',
      status: 'info',
      message: `Starting packet negotiation loop (max ${MAX_ROUNDS} rounds)`,
    });

    let currentPacket = initialPacket;
    let roundNumber = 0;

    while (roundNumber < MAX_ROUNDS) {
      roundNumber += 1;

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_round_started',
        state: 'NEGOTIATING',
        status: 'info',
        message: `Starting review round ${roundNumber}/${MAX_ROUNDS}`,
      });

      const reviewResult = await this.reviewer.review(
        executionId,
        storyId,
        currentPacket,
        codebaseSnapshot,
      );

      await this.negotiationRepository.saveRound(
        executionId,
        storyId,
        roundNumber,
        reviewResult.verdict,
        reviewResult.issues,
        roundNumber === 1 ? null : currentPacket.packetId,
      );

      if (reviewResult.verdict === 'APPROVED') {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'negotiation_approved',
          state: 'NEGOTIATING',
          status: 'success',
          message: `Packet approved after ${roundNumber} round(s)`,
        });

        return {
          approved: true,
          finalPacket: currentPacket,
          roundsCompleted: roundNumber,
          diagnosticMessage: `Packet approved by reviewer after ${roundNumber} round(s).`,
        };
      }

      // verdict === 'QUESTIONS'
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_questions_raised',
        state: 'NEGOTIATING',
        status: 'warn',
        message: `Round ${roundNumber} raised ${reviewResult.issues.length} issue(s): ${reviewResult.issues.join('; ')}`,
      });

      if (roundNumber === MAX_ROUNDS) {
        break;
      }

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_requesting_revision',
        state: 'NEGOTIATING',
        status: 'info',
        message: `Requesting Forge revision for round ${roundNumber + 1}`,
      });

      currentPacket = await forgeRevise(reviewResult.issues);
    }

    // 3 rounds exhausted without APPROVED
    const allRounds = await this.negotiationRepository.getRoundsByExecutionId(executionId);
    const finalRoundIssues = allRounds
      .filter((r) => r.roundNumber === MAX_ROUNDS)
      .flatMap((r) => r.issues)
      .join('; ') || 'none recorded';

    const diagnostic = `Packet negotiation failed after ${MAX_ROUNDS} rounds. Final reviewer issues: ${finalRoundIssues}`;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'negotiation_exhausted',
      state: 'NEGOTIATING',
      status: 'error',
      message: diagnostic,
    });

    return {
      approved: false,
      finalPacket: currentPacket,
      roundsCompleted: MAX_ROUNDS,
      diagnosticMessage: diagnostic,
    };
  }
}
