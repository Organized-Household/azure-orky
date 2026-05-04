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

  if (validation.kind === "ignored") {
    sendJson(res, 200, {
      received: true,
      ignored: true,
      reason: validation.reason,
    });
    return;
  }

  if (validation.kind === "invalid") {
    await executionFactory.createRejectedExecution(validation);
    sendJson(res, 400, { error: "Invalid payload" });
    return;
  }

  try {
    const result = await executionFactory.createValidatedExecution(validation);
    sendJson(res, 200, {
      received: result.received,
      executionId: result.executionId,
      storyId: result.storyId,
      status: result.status,
    });
  } catch {
    sendJson(res, 502, { error: "Jira story retrieval failed" });
  }
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

