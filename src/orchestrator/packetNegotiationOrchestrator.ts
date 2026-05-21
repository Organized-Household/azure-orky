import { InstructionPacket } from '../domain/instructionPacket';
import { AuditLogger } from '../audit/auditLogger';
import { PacketReviewer, PacketReviewResult } from '../integrations/review/packetReviewer';
import { PacketNegotiationRepository } from '../db/repositories/packetNegotiationRepository';
import { ExecutionRepository } from '../db/repositories/executionRepository';
import { CompilationChecker } from '../integrations/typescript/compilationChecker';
import { parseNegotiationFailure } from './negotiationDiagnostic';

const PROTECTED_FILES = [
  'src/db/repositories/executionRepository.ts',
];

// Matches file paths like src/foo/bar.ts in compilation error messages
const FILE_PATH_PATTERN = /\bsrc\/[\w/.-]+\.ts\b/g;

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
    forgeRevise: (issues: string[], currentPacket: InstructionPacket, contextFiles?: Record<string, string>) => Promise<InstructionPacket>,
    snapshotFiles?: Array<{ path: string; content: string }>,
  ): Promise<NegotiationResult> {
    // ORKY-66: resolved per-call so env changes take effect without restart
    const maxRounds = parseInt(process.env.NEGOTIATION_MAX_ROUNDS ?? '3', 10);

    // ORKY-95: Skip TypeScript compilation check when env var is set.
    // Required for non-Orky projects (e.g. React Native) whose dependencies
    // do not exist in Orky's node_modules. PacketReviewer serves as sole gate.
    // Set NEGOTIATION_SKIP_COMPILATION=true in Railway for non-Orky projects.
    const skipCompilation = process.env.NEGOTIATION_SKIP_COMPILATION === 'true';

    await this.executionRepository.updateState(executionId, 'NEGOTIATING');

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'NEGOTIATION_START',
      state: 'NEGOTIATING',
      status: 'info',
      message: `Negotiation starting. maxRounds=${maxRounds}, skipCompilation=${skipCompilation}`,
    });

    if (skipCompilation) {
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_compilation_skipped',
        state: 'NEGOTIATING',
        status: 'info',
        message: 'TypeScript compilation check skipped (NEGOTIATION_SKIP_COMPILATION=true) — PacketReviewer is sole gate',
      });
    }

    const snapshotMap = new Map((snapshotFiles ?? []).map((f) => [f.path, f.content]));

    let currentPacket = initialPacket;
    let roundNumber = 0;
    let previousRoundIssues: string[] = [];
    let previousIssuesJson: string | null = null;

    while (roundNumber < maxRounds) {
      roundNumber += 1;

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_round_started',
        state: 'NEGOTIATING',
        status: 'info',
        message: `Starting review round ${roundNumber}/${maxRounds}`,
      });

      // --- Protected file guard ---
      const forbiddenOp = currentPacket.fileOperations.find((op) =>
        PROTECTED_FILES.includes(op.path),
      );

      let compilationErrors: string[] = [];
      let reviewResult: PacketReviewResult;

      if (forbiddenOp) {
        await this.auditLogger.log({
          executionId,
          storyId,
          step: 'negotiation_protected_file_violation',
          state: 'NEGOTIATING',
          status: 'warn',
          message: `Round ${roundNumber}: DIP attempts to ${forbiddenOp.operation} protected file — ${forbiddenOp.path}`,
          metadata: { forbiddenPath: forbiddenOp.path, operation: forbiddenOp.operation },
        });
        reviewResult = {
          verdict: 'QUESTIONS',
          issues: [
            `DIP attempts to ${forbiddenOp.operation} src/db/repositories/executionRepository.ts — this file is protected and must never be modified. Remove this fileOperation entirely. Existing method names (updateState, getById, failIfNotTerminal, acquireLock, releaseLock, hasActiveOrCompletedExecution) are immutable — never rename them.`,
          ],
        };
      } else {
        // --- TypeScript compilation check ---
        // ORKY-95: Skipped when NEGOTIATION_SKIP_COMPILATION=true (non-Orky projects)
        if (!skipCompilation) {
          compilationErrors = await this.compilationChecker.check(currentPacket.fileOperations);

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
        }

        // --- Semantic review ---
        reviewResult = await this.reviewer.review(
          executionId,
          storyId,
          currentPacket,
          codebaseSnapshot,
        );
      }

      // --- Combine all issues ---
      const allIssues = [
        ...compilationErrors.map((e) => `[TypeScript compilation error] ${e}`),
        ...reviewResult.issues,
      ];

      const approved = compilationErrors.length === 0 && reviewResult.verdict === 'APPROVED';

      // --- ORKY-63 / ORKY-95: Stall detection (before persisting round) ---
      // ORKY-95 fix: compare allIssues (compilation + reviewer) not reviewResult.issues alone.
      // Previously only compared reviewer issues — caused false stall when reviewer approved
      // but compilation errors existed (e.g. React Native imports not in Orky node_modules).
      if (!approved) {
        const currentIssuesJson = JSON.stringify(
          [...allIssues].sort()
        );

        if (previousIssuesJson !== null && currentIssuesJson === previousIssuesJson) {
          const stallReason =
            `NEGOTIATION_STALL_DETECTED: identical issues returned in consecutive rounds ` +
            `(round ${roundNumber - 1} and round ${roundNumber}). Issues: ${currentIssuesJson}`;

          await this.auditLogger.log({
            executionId,
            storyId,
            step: 'NEGOTIATION_STALL',
            state: 'FAILED',
            status: 'error',
            message: stallReason,
            metadata: parseNegotiationFailure(stallReason),
          });

          await this.executionRepository.failIfNotTerminal(executionId, stallReason);

          return {
            approved: false,
            finalPacket: currentPacket,
            roundsCompleted: roundNumber,
            diagnosticMessage: stallReason,
          };
        }

        previousIssuesJson = currentIssuesJson;
      }

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

      if (roundNumber === maxRounds) {
        break;
      }

      // --- Build context files for revision (ORKY-61) ---
      const contextFiles: Record<string, string> = {};

      // Extract file paths from compilation error messages
      for (const err of compilationErrors) {
        const matches = err.match(FILE_PATH_PATTERN) ?? [];
        for (const filePath of matches) {
          const content = snapshotMap.get(filePath);
          if (content && !contextFiles[filePath]) {
            contextFiles[filePath] = content.slice(0, 3_000);
          }
        }
      }

      // If any errors repeat from the previous round, broaden context to
      // include files referenced in the DIP's own fileOperations
      const hasRepeatingErrors = previousRoundIssues.some((prev) => allIssues.includes(prev));
      if (hasRepeatingErrors) {
        for (const op of currentPacket.fileOperations) {
          const content = snapshotMap.get(op.path);
          if (content && !contextFiles[op.path]) {
            contextFiles[op.path] = content.slice(0, 3_000);
          }
        }
      }

      previousRoundIssues = allIssues;

      const contextFileCount = Object.keys(contextFiles).length;

      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'negotiation_requesting_revision',
        state: 'NEGOTIATING',
        status: 'info',
        message: `Requesting Forge revision for round ${roundNumber + 1} with ${allIssues.length} issue(s) and ${contextFileCount} context file(s)`,
        metadata: {
          contextFileCount,
          contextFilePaths: Object.keys(contextFiles),
          hasRepeatingErrors,
        },
      });

      currentPacket = await forgeRevise(
        allIssues,
        currentPacket,
        contextFileCount > 0 ? contextFiles : undefined,
      );
    }

    // maxRounds exhausted without approval
    const allRounds = await this.negotiationRepository.getRoundsByExecutionId(executionId);
    const finalRoundIssues =
      allRounds
        .filter((r) => r.roundNumber === maxRounds)
        .flatMap((r) => r.issues)
        .join('; ') || 'none recorded';

    const exhaustedReason = `NEGOTIATION_EXHAUSTED: no APPROVED verdict after ${maxRounds} rounds`;
    const diagnostic = `${exhaustedReason}. Final issues: ${finalRoundIssues}`;

    await this.auditLogger.log({
      executionId,
      storyId,
      step: 'negotiation_exhausted',
      state: 'NEGOTIATING',
      status: 'error',
      message: diagnostic,
      metadata: parseNegotiationFailure(exhaustedReason),
    });

    return {
      approved: false,
      finalPacket: currentPacket,
      roundsCompleted: maxRounds,
      diagnosticMessage: exhaustedReason,
    };
  }
}
