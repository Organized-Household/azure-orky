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
  // STORY-9.4: Extended DIP fields
  prTitle: string;
  prBody: string;
  commitMessage: string;
  implementationSummary: string;
  jiraLinkage: string;
}
