import { getPool } from '../dbClient';

export interface RepoChangeSetRecord {
  changeSetId: string;
  executionId: string;
  storyId: string;
  workspacePath: string | null;
  changedFiles: string[] | null;
}

export class RepoChangeSetRepository {
  async getByExecutionId(executionId: string): Promise<RepoChangeSetRecord | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT change_set_id AS "changeSetId",
              execution_id AS "executionId",
              story_id AS "storyId",
              workspace_path AS "workspacePath",
              changed_files AS "changedFiles"
       FROM repo_change_sets
       WHERE execution_id = $1
       LIMIT 1`,
      [executionId],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      ...row,
      changedFiles: row.changedFiles ? (JSON.parse(row.changedFiles) as string[]) : null,
    };
  }

  async updateBranchAndPr(
    executionId: string,
    branchName: string,
    commitSha: string,
    prUrl: string,
    headSha: string,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE repo_change_sets
       SET branch_name = $1,
           commit_sha  = $2,
           pr_url      = $3,
           head_sha    = $4,
           updated_at  = NOW()
       WHERE execution_id = $5`,
      [branchName, commitSha, prUrl, headSha, executionId],
    );
  }

  async updateMergeSha(executionId: string, mergeSha: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE repo_change_sets
       SET merge_sha  = $1,
           updated_at = NOW()
       WHERE execution_id = $2`,
      [mergeSha, executionId],
    );
  }
}
