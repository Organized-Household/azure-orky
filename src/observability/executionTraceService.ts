import { AuditLogRepository } from "../db/repositories/auditLogRepository";
import { ExecutionRepository } from "../db/repositories/executionRepository";

export class ExecutionTraceService {
  constructor(
    private readonly executionRepository = new ExecutionRepository(),
    private readonly auditLogRepository = new AuditLogRepository(),
  ) {}

  async getTrace(executionId: string): Promise<{
    execution: object;
    auditLog: object[];
  } | null> {
    const execution = await this.executionRepository.getById(executionId);

    if (!execution) {
      return null;
    }

    const auditLog =
      await this.auditLogRepository.getByExecutionId(executionId);

    return {
      execution,
      auditLog: auditLog.map((entry) => ({
        ...entry,
        metadataJson: entry.metadataJson
          ? JSON.parse(entry.metadataJson)
          : undefined,
      })),
    };
  }
}