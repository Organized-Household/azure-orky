import { FileOperation, InstructionPacket } from '../../domain/instructionPacket';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const VALID_OPERATIONS = new Set<string>(['create', 'modify', 'replace', 'delete']);

export class InstructionValidator {
  validate(packet: unknown): ValidationResult {
    if (!packet || typeof packet !== 'object') {
      return { valid: false, reason: 'Packet is not an object' };
    }

    const p = packet as Record<string, unknown>;

    for (const field of [
      'packetId',
      'storyId',
      'targetRepository',
      'baseBranch',
      'branchNameHint',
      'prTitle',
      'prBody',
      'commitMessage',
      'implementationSummary',
      'jiraLinkage',
    ] as const) {
      if (!p[field] || typeof p[field] !== 'string' || (p[field] as string).trim() === '') {
        return { valid: false, reason: `Missing or empty required field: ${field}` };
      }
    }

    if (!Array.isArray(p.fileOperations) || p.fileOperations.length === 0) {
      return { valid: false, reason: 'fileOperations must be a non-empty array' };
    }

    for (let i = 0; i < p.fileOperations.length; i++) {
      const op = p.fileOperations[i] as Partial<FileOperation>;

      if (!op.operation || !VALID_OPERATIONS.has(op.operation)) {
        return {
          valid: false,
          reason: `fileOperations[${i}].operation must be one of: create, modify, replace, delete`,
        };
      }

      if (!op.path || typeof op.path !== 'string' || op.path.trim() === '') {
        return { valid: false, reason: `fileOperations[${i}].path is missing or empty` };
      }
    }

    if (!Array.isArray(p.validationCommands)) {
      return { valid: false, reason: 'validationCommands must be an array' };
    }

    return { valid: true };
  }
}
