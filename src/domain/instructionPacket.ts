export interface FileOperation {
  operation: 'create' | 'modify' | 'replace' | 'delete';
  path: string;
  content?: string;
}

export interface InstructionPacket {
  packetId: string;
  storyId: string;
  targetRepository: string;
  baseBranch: string;
  branchNameHint: string;
  fileOperations: FileOperation[];
  validationCommands: string[];
}