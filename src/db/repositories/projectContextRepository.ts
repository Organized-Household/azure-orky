import { getPool } from '../dbClient';

export interface ProjectContextEntry {
  id: number;
  artifactType: string;
  artifactKey: string;
  content: string;
}

export class ProjectContextRepository {
  async getAll(): Promise<ProjectContextEntry[]> {
    const pool = getPool();
    const result = await pool.query<{
      id: number;
      artifact_type: string;
      artifact_key: string;
      content: string;
    }>(
      `SELECT id, artifact_type, artifact_key, content
       FROM project_context
       ORDER BY artifact_type, artifact_key`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      artifactType: row.artifact_type,
      artifactKey: row.artifact_key,
      content: row.content,
    }));
  }

  async getByType(type: string): Promise<ProjectContextEntry[]> {
    const pool = getPool();
    const result = await pool.query<{
      id: number;
      artifact_type: string;
      artifact_key: string;
      content: string;
    }>(
      `SELECT id, artifact_type, artifact_key, content
       FROM project_context
       WHERE artifact_type = $1
       ORDER BY artifact_key`,
      [type],
    );
    return result.rows.map((row) => ({
      id: row.id,
      artifactType: row.artifact_type,
      artifactKey: row.artifact_key,
      content: row.content,
    }));
  }

  async getByProjectKey(projectKey: string): Promise<ProjectContextEntry[]> {
    const pool = getPool();
    const result = await pool.query<{
      id: number;
      artifact_type: string;
      artifact_key: string;
      content: string;
    }>(
      `SELECT id, artifact_type, artifact_key, content
       FROM project_context
       WHERE project_key = $1
       ORDER BY artifact_type, artifact_key`,
      [projectKey],
    );
    return result.rows.map((row) => ({
      id: row.id,
      artifactType: row.artifact_type,
      artifactKey: row.artifact_key,
      content: row.content,
    }));
  }
}
