import {
  findAcceptanceCriteria,
  findEpicId,
  toPlainText,
} from "../integrations/jira/storyRetrievalService";

export interface JiraWebhookValidationResult {
  valid: boolean;
  ignored?: boolean;
  reason?: string;
  missingFields?: string[];

  storyId?: string;
  issueId?: string;
  projectKey?: string;
  epicId?: string;
  status?: string;
}

function asRecord(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }

  return {};
}

function isIssueUpdatedEvent(webhookEvent: string | undefined): boolean {
  return webhookEvent === "jira:issue_updated" || webhookEvent === "issue_updated";
}

function getTargetStatus(payload: Record<string, any>): string | undefined {
  const changelog = asRecord(payload.changelog);
  const items = Array.isArray(changelog.items) ? changelog.items : [];

  const statusItem = items.find((item) => {
    const itemRecord = asRecord(item);
    const fieldName = toPlainText(itemRecord.field);
    return fieldName?.toLowerCase() === "status";
  });

  if (!statusItem) {
    return undefined;
  }

  const statusRecord = asRecord(statusItem);
  return toPlainText(statusRecord.toString);
}

export function validateJiraWebhookPayload(
  payload: unknown
): JiraWebhookValidationResult {
  const root = asRecord(payload);

  const webhookEvent = toPlainText(root.webhookEvent);
  const targetStatus = getTargetStatus(root);

  if (!isIssueUpdatedEvent(webhookEvent) || targetStatus !== "Ready for Engineering") {
    return {
      valid: false,
      ignored: true,
      reason: "Non-triggering Jira event",
      status: targetStatus,
    };
  }

  const issue = asRecord(root.issue);
  const fields = asRecord(issue.fields);

  const storyId = toPlainText(issue.key);
  const issueId = toPlainText(issue.id);

  const summary = toPlainText(fields.summary);
  const description = toPlainText(fields.description);
  const acceptanceCriteria = findAcceptanceCriteria(fields);
  const epicId = findEpicId(fields);

  const projectKey =
    toPlainText(asRecord(fields.project).key) ||
    (storyId ? storyId.split("-")[0] : undefined);

  const issueType = toPlainText(asRecord(fields.issuetype).name);

  const missingFields = [
    !storyId ? "issue.key" : undefined,
    !issueId ? "issue.id" : undefined,
    !summary ? "fields.summary" : undefined,
    !description ? "fields.description" : undefined,
    !acceptanceCriteria ? "acceptance criteria" : undefined,
    !epicId ? "epic / parent" : undefined,
    !projectKey ? "project.key" : undefined,
    !issueType ? "issuetype.name" : undefined,
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: "Invalid payload",
      missingFields,
      storyId,
      issueId,
      projectKey,
      epicId,
      status: targetStatus,
    };
  }

  return {
    valid: true,
    storyId: storyId as string,
    issueId: issueId as string,
    projectKey: projectKey as string,
    epicId: epicId as string,
    status: targetStatus,
  };
}