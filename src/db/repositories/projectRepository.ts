import { getPool } from '../dbClient';

export interface ProjectRecord {
  projectKey: string;
  displayName: string;
  targetRepository: string;
  baseBranch: string;
  createdAt: Date;
  updatedAt: Date;
}

export class ProjectRepository {
  async getByProjectKey(projectKey: string): Promise<ProjectRecord | null> {
    const pool = getPool();
    const result = await pool.query<{
      project_key: string;
      display_name: string;
      target_repository: string;
      base_branch: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT project_key, display_name, target_repository, base_branch, created_at, updated_at
       FROM projects
       WHERE project_key = $1`,
      [projectKey],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      projectKey: row.project_key,
      displayName: row.display_name,
      targetRepository: row.target_repository,
      baseBranch: row.base_branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
