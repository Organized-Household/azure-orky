/**
 * negotiationDiagnostic.ts
 * ORKY-64 / STORY-14.2 — Structured Failure Diagnostics
 *
 * Pure function: parses negotiation failure reason strings into typed
 * diagnostic structs. No I/O, no side effects, no external dependencies.
 */

export type NegotiationFailureKind =
  | 'STALL_DETECTED'
  | 'ROUNDS_EXHAUSTED'
  | 'UNKNOWN';

export interface NegotiationDiagnostic {
  /** Parsed failure category */
  kind: NegotiationFailureKind;
  /** STALL_DETECTED: the round number at which stall was confirmed */
  stalledAtRound: number | null;
  /** ROUNDS_EXHAUSTED: how many rounds were attempted */
  roundsAttempted: number | null;
  /** Human-readable summary of the issues that caused failure */
  issuesSummary: string | null;
  /** The original unmodified failure reason string */
  rawReason: string;
}

const STALL_PREFIX = 'NEGOTIATION_STALL_DETECTED';
const EXHAUSTED_PREFIX = 'NEGOTIATION_EXHAUSTED';

/**
 * Parse a negotiation failure reason string into a structured diagnostic.
 *
 * Handles two known formats produced by packetNegotiationOrchestrator:
 *   NEGOTIATION_STALL_DETECTED: identical issues returned in consecutive
 *     rounds (round N and round N+1). Issues: [...]
 *   NEGOTIATION_EXHAUSTED: no APPROVED verdict after N rounds
 *
 * Returns kind='UNKNOWN' for any unrecognised input — never throws.
 */
export function parseNegotiationFailure(reason: string): NegotiationDiagnostic {
  if (reason.startsWith(STALL_PREFIX)) {
    const roundMatch = reason.match(/round (\d+) and round (\d+)/);
    const stalledAtRound = roundMatch ? parseInt(roundMatch[2], 10) : null;

    const issuesMatch = reason.match(/Issues:\s*(.+)$/s);
    const issuesSummary = issuesMatch ? issuesMatch[1].trim() : null;

    return {
      kind: 'STALL_DETECTED',
      stalledAtRound,
      roundsAttempted: stalledAtRound,
      issuesSummary,
      rawReason: reason,
    };
  }

  if (reason.startsWith(EXHAUSTED_PREFIX)) {
    const roundsMatch = reason.match(/after (\d+) rounds/);
    const roundsAttempted = roundsMatch ? parseInt(roundsMatch[1], 10) : null;

    return {
      kind: 'ROUNDS_EXHAUSTED',
      stalledAtRound: null,
      roundsAttempted,
      issuesSummary: null,
      rawReason: reason,
    };
  }

  return {
    kind: 'UNKNOWN',
    stalledAtRound: null,
    roundsAttempted: null,
    issuesSummary: null,
    rawReason: reason,
  };
}
