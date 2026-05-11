import { InstructionPacket } from '../domain/instructionPacket';

export interface MutationAgentInput {
  executionId: string;
  workspacePath: string;
  instructionPacket: InstructionPacket;
}

export interface MutationResult {
  success: boolean;
  changedFiles: string[];
  diffSummary: string;
  validationOutput: string;
  error?: string;
}

export interface MutationAgentAdapter {
  execute(input: MutationAgentInput): Promise<MutationResult>;
}
