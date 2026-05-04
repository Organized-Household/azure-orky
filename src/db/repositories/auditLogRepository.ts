import { randomUUID } from "crypto";
import sql from "mssql";
import { getDbPool } from "../dbClient";

export interface AuditLogInput {
  executionId: string;
  storyId: string;
  step: string;
  state: string;
  status: string;
  message?: string;
  metadataJson?: string;
}

export class AuditLogRepository {
  async create(input: AuditLogInput): Promise<void> {
    const pool = await getDbPool();

    await pool
      .request()
      .input("auditLogId", sql.UniqueIdentifier, randomUUID())
      .input("executionId", sql.UniqueIdentifier, input.executionId)
      .input("storyId", sql.VarChar(255), input.storyId)
      .input("step", sql.VarChar(100), input.step)
      .input("state", sql.VarChar(50), input.state)
      .input("status", sql.VarChar(50), input.status)
      .input("message", sql.NVarChar(sql.MAX), input.message ?? null)
      .input("metadataJson", sql.NVarChar(sql.MAX), input.metadataJson ?? null)
      .query(`
        INSERT INTO audit_logs (
          audit_log_id,
          execution_id,
          story_id,
          step,
          state,
          status,
          message,
          metadata_json
        )
        VALUES (
          @auditLogId,
          @executionId,
          @storyId,
          @step,
          @state,
          @status,
          @message,
          @metadataJson
        )
      `);
  }
}

