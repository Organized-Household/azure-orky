import { IncomingMessage, ServerResponse } from "http";
import { ExecutionFactory } from "../orchestrator/executionFactory";
import { validateJiraWebhookPayload } from "./jiraWebhookValidator";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export async function handleJiraWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readRequestBody(req));
  } catch {
    sendJson(res, 400, { error: "Invalid payload" });
    return;
  }

  const validation = validateJiraWebhookPayload(payload);
  const executionFactory = new ExecutionFactory();

  // Non-triggering event: valid parse but not a Ready for Engineering transition
  if (validation.ignored === true) {
    sendJson(res, 200, {
      received: true,
      ignored: true,
      reason: validation.reason,
    });
    return;
  }

  // Failed field validation: event was triggering but payload is incomplete
  if (validation.valid === false) {
    console.warn("Jira webhook validation failed", {
      missingFields: validation.missingFields,
    });
    try {
      await executionFactory.createRejectedExecution(validation);
    } catch (error) {
      console.error("Jira webhook validation audit failed", {
        detail: getSafeProcessingFailureDetail(error),
      });
    }
    sendJson(res, 400, {
      error: "Invalid payload",
      ...(shouldIncludeLocalDetails()
        ? { missingFields: validation.missingFields }
        : {}),
    });
    return;
  }

  // Happy path: valid triggering event with all required fields
  try {
    const result = await executionFactory.createValidatedExecution(validation);
    sendJson(res, 200, {
      received: result.received,
      executionId: result.executionId,
      storyId: result.storyId,
      status: result.status,
    });
  } } catch (error) {
    const detail = getSafeProcessingFailureDetail(error);
    console.error("Jira webhook processing failed", { detail });
    console.error("RAW ERROR:", error instanceof Error ? error.stack : String(error));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    req.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) {
        reject(new Error("Webhook payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function shouldIncludeLocalDetails(): boolean {
  return process.env.NODE_ENV !== "production";
}

function getSafeProcessingFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Missing Jira configuration")) {
    return "Missing Jira configuration: JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN";
  }
  const jiraStatusMatch = message.match(/Jira issue fetch failed with status \d+/);
  if (jiraStatusMatch) {
    return jiraStatusMatch[0];
  }
  const missingStoryFieldMatch = message.match(
    /Missing required Jira story field: (.+)$/,
  );
  if (missingStoryFieldMatch) {
    return `Fetched Jira story missing required field: ${missingStoryFieldMatch[1]}`;
  }
  if (
    message.includes("Invalid object name 'executions'") ||
    message.includes('Invalid object name "executions"')
  ) {
    return "Database schema missing: run 001_create_executions.sql";
  }
  if (
    message.includes("Invalid object name 'audit_logs'") ||
    message.includes('Invalid object name "audit_logs"')
  ) {
    return "Database schema missing: run 002_create_audit_logs.sql";
  }
  if (message.toLowerCase().includes("login failed")) {
    return "Database login failed";
  }
  return "Processing failed after payload validation";
}