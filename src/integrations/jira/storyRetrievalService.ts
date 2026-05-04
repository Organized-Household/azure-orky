import { StoryPayload } from "../../domain/storyPayload";
import { JiraClient } from "./jiraClient";

type JsonRecord = Record<string, unknown>;

export class StoryRetrievalService {
  constructor(private readonly jiraClient = new JiraClient()) {}

  async retrieve(issueId: string): Promise<StoryPayload> {
    const issue = await this.jiraClient.getIssue(issueId);
    return normalizeJiraIssue(issue);
  }
}

export function normalizeJiraIssue(issue: unknown): StoryPayload {
  const issueRecord = asRecord(issue);
  const fields = asRecord(issueRecord.fields);
  const storyId = getRequiredString(issueRecord.key, "issue key / storyId");
  const issueId = getRequiredString(issueRecord.id, "issueId");
  const projectKey =
    toPlainText(asRecord(fields.project).key) || storyId.split("-")[0] || "";
  const summary = getRequiredText(fields.summary, "summary");
  const description = getRequiredText(fields.description, "description");
  const acceptanceCriteria = getRequiredText(
    findFieldValue(fields, acceptanceCriteriaFieldNames()),
    "acceptance criteria",
  );
  const epicId = getRequiredText(findEpicFieldValue(fields), "epic link");

  return {
    storyId,
    issueId,
    projectKey,
    summary,
    description,
    acceptanceCriteria,
    epicId,
  };
}

export function findAcceptanceCriteria(fields: unknown): unknown {
  return findFieldValue(asRecord(fields), acceptanceCriteriaFieldNames());
}

export function findEpicId(fields: unknown): unknown {
  return findEpicFieldValue(asRecord(fields));
}

export function toPlainText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(toPlainText).filter(Boolean).join("\n").trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as JsonRecord;
  if (typeof record.key === "string") {
    return record.key.trim();
  }

  if (typeof record.id === "string") {
    return record.id.trim();
  }

  if (typeof record.name === "string") {
    return record.name.trim();
  }

  if (typeof record.value === "string") {
    return record.value.trim();
  }

  if (Array.isArray(record.content)) {
    return record.content.map(toPlainText).filter(Boolean).join("\n").trim();
  }

  if (typeof record.text === "string") {
    return record.text.trim();
  }

  return "";
}

function acceptanceCriteriaFieldNames(): string[] {
  return [
    process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD,
    "acceptanceCriteria",
    "acceptance_criteria",
    "acceptance criteria",
    "customfield_acceptance_criteria",
    "customfield_10016",
  ].filter((fieldName): fieldName is string => Boolean(fieldName));
}

function epicFieldNames(): string[] {
  return [
    process.env.JIRA_EPIC_LINK_FIELD,
    "epicId",
    "epic_id",
    "epicLink",
    "epic_link",
    "epic",
    "parent",
    "customfield_10008",
    "customfield_10014",
  ].filter((fieldName): fieldName is string => Boolean(fieldName));
}

function findEpicFieldValue(fields: JsonRecord): unknown {
  return findFieldValue(fields, epicFieldNames());
}

function findFieldValue(fields: JsonRecord, fieldNames: string[]): unknown {
  for (const fieldName of fieldNames) {
    if (fields[fieldName] !== undefined && toPlainText(fields[fieldName])) {
      return fields[fieldName];
    }
  }

  const normalizedNames = fieldNames.map(normalizeFieldName);
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = normalizeFieldName(key);
    if (
      normalizedNames.includes(normalizedKey) ||
      normalizedKey.includes("acceptancecriteria")
    ) {
      if (toPlainText(value)) {
        return value;
      }
    }
  }

  return undefined;
}

function getRequiredString(value: unknown, fieldName: string): string {
  const text = toPlainText(value);
  if (!text) {
    throw new Error(`Missing required Jira story field: ${fieldName}`);
  }

  return text;
}

function getRequiredText(value: unknown, fieldName: string): string {
  return getRequiredString(value, fieldName);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
}
