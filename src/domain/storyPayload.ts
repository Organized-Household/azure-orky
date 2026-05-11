export const EXECUTION_STATES = {
  RECEIVED: "RECEIVED",
  VALIDATED: "VALIDATED",
  STORY_FETCHED: "STORY_FETCHED",
  ARTIFACTS_RESOLVED: "ARTIFACTS_RESOLVED",
  FORGE_INVOKED: "FORGE_INVOKED",
  PACKET_RECEIVED: "PACKET_RECEIVED",
  PACKET_VALIDATED: "PACKET_VALIDATED",
  AGENT_EXECUTING: "AGENT_EXECUTING",
  CHANGES_PREPARED: "CHANGES_PREPARED",
  PR_CREATED: "PR_CREATED",
  CI_PENDING: "CI_PENDING",
  CI_PASSED: "CI_PASSED",
  MERGED: "MERGED",
  COMPLETED: "COMPLETED",
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