export const EXECUTION_STATES = {
  RECEIVED: "RECEIVED",
  VALIDATED: "VALIDATED",
  STORY_FETCHED: "STORY_FETCHED",
  FAILED: "FAILED",
} as const;

export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];

export interface StoryPayload {
  // Existing compatibility fields used by current repositories/orchestrator
  storyId: string;
  issueId?: string;
  epicId?: string;

  // Explicit Jira/PDE-normalized fields
  jiraIssueKey: string;
  jiraIssueId?: string;

  PDEStoryID: string;
  PDEEpicID?: string;

  projectKey: string;
  issueType: string;
  status: string;

  title: string;
  description: string;
  acceptanceCriteria: string;

  parentKey?: string;
  labels?: string[];
  priority?: string;
}