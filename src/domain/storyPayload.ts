export interface StoryPayload {
  storyId: string;
  issueId: string;
  projectKey: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  epicId: string;
}

export const EXECUTION_STATES = {
  RECEIVED: "RECEIVED",
  VALIDATED: "VALIDATED",
  STORY_FETCHED: "STORY_FETCHED",
  FAILED: "FAILED",
} as const;

export type ExecutionState =
  (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];

