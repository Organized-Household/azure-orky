import { StoryPayload } from "../../domain/storyPayload";
import { JiraClient } from "./jiraClient";

type JiraIssue = {
  id?: string;
  key: string;
  fields: Record<string, any>;
};

export function toPlainText(value: any): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((item) => toPlainText(item))
      .filter(Boolean)
      .join("\n");

    return joined.trim().length > 0 ? joined.trim() : undefined;
  }

  if (typeof value === "object") {
    if (typeof value.value === "string") return value.value.trim();
    if (typeof value.name === "string") return value.name.trim();
    if (typeof value.key === "string") return value.key.trim();
    if (typeof value.text === "string") return value.text.trim();

    if (Array.isArray(value.content)) {
      const joined = value.content
        .map((node: any) => toPlainText(node))
        .filter(Boolean)
        .join("\n");

      return joined.trim().length > 0 ? joined.trim() : undefined;
    }
  }

  return undefined;
}

export function findAcceptanceCriteria(fields: Record<string, any>): string | undefined {
  const configuredField =
    process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD ?? "customfield_10108";

  return (
    toPlainText(fields[configuredField]) ??
    toPlainText(fields.acceptanceCriteria) ??
    toPlainText(fields["Acceptance Criteria"])
  );
}

export function findEpicId(fields: Record<string, any>): string | undefined {
  const configuredPdeEpicField =
    process.env.JIRA_PDE_EPIC_ID_FIELD ?? "customfield_10106";

  const configuredEpicLinkField =
    process.env.JIRA_EPIC_LINK_FIELD ?? "parent";

  return (
    toPlainText(fields[configuredPdeEpicField]) ??
    toPlainText(fields[configuredEpicLinkField]) ??
    toPlainText(fields.parent?.key)
  );
}

function required(value: string | undefined, fieldName: string): string {
  if (!value) {
    throw new Error(`Fetched Jira story missing required field: ${fieldName}`);
  }

  return value;
}

function extractPDEIdFromText(
  value: string | undefined,
  prefix: "STORY" | "EPIC"
): string | undefined {
  if (!value) return undefined;

  const match = value.match(new RegExp(`\\b${prefix}-\\d+(?:\\.\\d+)?\\b`, "i"));
  return match?.[0]?.toUpperCase();
}

export class StoryRetrievalService {
  constructor(private readonly jiraClient: JiraClient = new JiraClient()) {}

  async retrieve(issueKeyOrId: string): Promise<StoryPayload> {
    return this.retrieveStory(issueKeyOrId);
  }

  async retrieveStory(issueKeyOrId: string): Promise<StoryPayload> {
    const issue = (await this.jiraClient.getIssue(issueKeyOrId)) as JiraIssue;
    const fields = issue.fields ?? {};

    const pdeStoryIdField =
      process.env.JIRA_PDE_STORY_ID_FIELD ?? "customfield_10107";

    const title = required(toPlainText(fields.summary), "summary");
    const description = required(toPlainText(fields.description), "description");

    const acceptanceCriteria =
      findAcceptanceCriteria(fields) ?? description;

    const PDEStoryID =
      toPlainText(fields[pdeStoryIdField]) ??
      extractPDEIdFromText(title, "STORY") ??
      issue.key;

    const PDEEpicID =
      findEpicId(fields) ??
      extractPDEIdFromText(title, "EPIC");

    return {
      storyId: issue.key,
      issueId: issue.id,
      epicId: PDEEpicID,

      jiraIssueKey: issue.key,
      jiraIssueId: issue.id,

      PDEStoryID,
      PDEEpicID,

      projectKey: required(toPlainText(fields.project?.key), "project key"),
      issueType: required(toPlainText(fields.issuetype?.name), "issue type"),
      status: required(toPlainText(fields.status?.name), "status"),

      title,
      description,
      acceptanceCriteria,

      parentKey: toPlainText(fields.parent?.key),
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      priority: toPlainText(fields.priority?.name),
    };
  }
}