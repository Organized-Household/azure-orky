import { AuditLogRepository } from "../db/repositories/auditLogRepository";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|credential|password|secret|token|api[_-]?key)/i;

export interface AuditEvent {
  executionId: string;
  storyId: string;
  step: string;
  state: string;
  status: string;
  message?: string;
  metadata?: unknown;
  batchExecutionId?: string;
}

export class AuditLogger {
  constructor(private readonly auditLogRepository = new AuditLogRepository()) {}

  async log(event: AuditEvent): Promise<void> {
    await this.auditLogRepository.create({
      executionId: event.executionId,
      storyId: event.storyId,
      step: event.step,
      state: event.state,
      status: event.status,
      message: event.message,
      batchExecutionId: event.batchExecutionId,
      metadataJson:
        event.metadata === undefined
          ? undefined
          : JSON.stringify(redactSensitiveValues(event.metadata)),
    });
  }
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveValues(item),
    ]),
  );
}

