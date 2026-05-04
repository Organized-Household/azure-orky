import {
  findAcceptanceCriteria,
  findEpicId,
  toPlainText,
} from "../integrations/jira/storyRetrievalService";

type JsonRecord = Record<string, unknown>;

export type JiraWebhookValidationResult =
  | {
      kind: "ignored";
      reason: string;
      webhookEvent?: string;
      targetStatus?: string;
    }
  | {
      kind: "invalid";
      reason: string;
      missingFields: string[];
      storyId?: string;
      issueId?: string;
      projectKey?: string;
      webhookEvent?: string;
      targetStatus?: string;
    }
  | {
      kind: "valid";
      storyId: string;
      issueId: string;
      projectKey: string;
      epicId: string;
      webhookEvent?: string;
      targetStatus: string;
    };

export function validateJiraWebhookPayload(
  payload: unknown,
): JiraWebhookValidationResult {
  const webhook = asRecord(payload);
  const webhookEvent = toPlainText(webhook.webhookEvent || webhook.event);
  const issue = asRecord(webhook.issue);
  const fields = asRecord(issue.fields);
  const targetStatus = getTargetStatus(webhook, fields);

  if (!isIssueUpdatedEvent(webhookEvent) || targetStatus !== "Ready for Engineering") {
    return {
      kind: "ignored",
      reason: "Non-triggering Jira event",
      webhookEvent,
      targetStatus,
    };
  }

  const storyId = toPlainText(issue.key);
  const issueId = toPlainText(issue.id);
  const projectKey =
    toPlainText(asRecord(fields.project).key) || storyId.split("-")[0] || undefined;
  const summary = toPlainText(fields.summary);
  const description = toPlainText(fields.description);
  const acceptanceCriteria = toPlainText(findAcceptanceCriteria(fields));
  const epicId = toPlainText(findEpicId(fields));
  const missingFields = [
    ["issueId", issueId],
    ["issue key / storyId", storyId],
    ["summary", summary],
    ["description", description],
    ["acceptance criteria", acceptanceCriteria],
    ["epic link", epicId],
  ]
    .filter(([, value]) => !value)
    .map(([fieldName]) => fieldName);

  if (missingFields.length > 0) {
    return {
      kind: "invalid",
      reason: "Invalid payload",
      missingFields,
      storyId,
      issueId,
      projectKey,
      webhookEvent,
      targetStatus,
    };
  }

  return {
    kind: "valid",
    storyId,
    issueId,
    projectKey: projectKey || storyId.split("-")[0],
    epicId,
    webhookEvent,
    targetStatus,
  };
}

function isIssueUpdatedEvent(webhookEvent: string): boolean {
  return webhookEvent === "issue_updated" || webhookEvent === "jira:issue_updated";
}

function getTargetStatus(webhook: JsonRecord, fields: JsonRecord): string {
  const changelog = asRecord(webhook.changelog);
  const items = Array.isArray(changelog.items) ? changelog.items : [];
  const statusChange = items
    .map(asRecord)
    .find((item) => toPlainText(item.field).toLowerCase() === "status");

  return (
    toPlainText(statusChange?.toString) ||
    toPlainText(statusChange?.to) ||
    toPlainText(asRecord(fields.status).name)
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

