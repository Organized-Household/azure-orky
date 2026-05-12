import { InstructionPacket } from '../domain/instructionPacket';
import { AuditLogger } from '../audit/auditLogger';
import { PacketReviewer } from '../integrations/review/packetReviewer';
import { PacketNegotiationRepository } from '../db/repositories/packetNegotiationRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { CompilationChecker } from '../integrations/typescript/compilationChecker';

const MAX_ROUNDS = 3;

export interface NegotiationResult {
  approved: boolean;
  finalPacket: InstructionPacket;
  roundsCompleted: number;
  diagnosticMessage: string;
}

export class PacketNegotiationOrchestrator {
  private readonly compilationChecker = new CompilationChecker();

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

      // --- TypeScript compilation check ---
      const compilationErrors = await this.compilationChecker.check(
        currentPacket.fileOperations,
      );

      if (compilationErrors.length > 0) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'negotiation_compilation_failed',
          state: 'NEGOTIATING',
          status: 'warn',
          message: `Round ${roundNumber}: ${compilationErrors.length} new TypeScript error(s)`,
          metadata: { compilationErrors },
        });
      }

      // --- Semantic review ---
      const reviewResult = await this.reviewer.review(
        executionId,
        storyId,
        currentPacket,
        codebaseSnapshot,
      );

      // --- Combine all issues ---
      const allIssues = [
        ...compilationErrors.map((e) => `[TypeScript compilation error] ${e}`),
        ...reviewResult.issues,
      ];

      const approved = compilationErrors.length === 0 && reviewResult.verdict === 'APPROVED';

      await this.negotiationRepository.saveRound(
        executionId,
        storyId,
        roundNumber,
        approved ? 'APPROVED' : 'QUESTIONS',
        allIssues,
        roundNumber === 1 ? null : currentPacket.packetId,
      );

      if (approved) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'negotiation_approved',
          state: 'NEGOTIATING',
          status: 'success',
          message: `Packet approved after ${roundNumber} round(s) (compiles clean, reviewer approved)`,
        });

        return {
          approved: true,
          finalPacket: currentPacket,
          roundsCompleted: roundNumber,
          diagnosticMessage: `Packet approved after ${roundNumber} round(s).`,
        };
      }

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_issues_found',
        state: 'NEGOTIATING',
        status: 'warn',
        message: `Round ${roundNumber}: ${allIssues.length} issue(s) — ${compilationErrors.length} compile error(s), ${reviewResult.issues.length} reviewer issue(s)`,
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
        message: `Requesting Forge revision for round ${roundNumber + 1} with ${allIssues.length} issue(s)`,
      });

      currentPacket = await forgeRevise(allIssues);
    }

    // MAX_ROUNDS exhausted without approval
    const allRounds = await this.negotiationRepository.getRoundsByExecutionId(executionId);
    const finalRoundIssues =
      allRounds
        .filter((r) => r.roundNumber === MAX_ROUNDS)
        .flatMap((r) => r.issues)
        .join('; ') || 'none recorded';

    const diagnostic = `Packet negotiation failed after ${MAX_ROUNDS} rounds. Final issues: ${finalRoundIssues}`;

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
