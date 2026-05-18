import { getPool } from '../db/dbClient';

export type CredentialType =
  | 'github_token'
  | 'jira_api_token'
  | 'jira_base_url'
  | 'jira_email'
  | 'jira_completion_transition_id'
  | 'jira_failure_transition_id';

// Fallback map: credential_type -> environment variable name
const ENV_FALLBACK: Record<CredentialType, string> = {
  github_token: 'GH_TOKEN',
  jira_api_token: 'JIRA_API_TOKEN',
  jira_base_url: 'JIRA_BASE_URL',
  jira_email: 'JIRA_EMAIL',
  jira_completion_transition_id: 'JIRA_COMPLETION_TRANSITION_ID',
  jira_failure_transition_id: 'JIRA_FAILURE_TRANSITION_ID',
};

export class CredentialResolver {
  /**
   * Resolve a credential for a project.
   * Queries project_credentials first; falls back to the corresponding
   * environment variable if no row exists.
   * NEVER logs the resolved value — only logs source (db or env).
   */
  async resolve(projectKey: string, credentialType: CredentialType): Promise<string | null> {
    // 1. Try database
    try {
      const pool = getPool();
      const result = await pool.query<{ credential_value: string }>(
        `SELECT credential_value FROM project_credentials
         WHERE project_key = $1 AND credential_type = $2`,
        [projectKey, credentialType],
      );
      if (result.rows[0]) {
        console.log(`[CredentialResolver] ${credentialType} for ${projectKey}: resolved from DB`);
        return result.rows[0].credential_value;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CredentialResolver] DB lookup failed for ${credentialType}/${projectKey}: ${msg} — falling back to env`);
    }

    // 2. Fall back to environment variable
    const envVar = ENV_FALLBACK[credentialType];
    const envValue = process.env[envVar] ?? null;
    if (envValue) {
      console.log(`[CredentialResolver] ${credentialType} for ${projectKey}: resolved from env (${envVar})`);
    } else {
      console.warn(`[CredentialResolver] ${credentialType} for ${projectKey}: not found in DB or env (${envVar})`);
    }
    return envValue;
  }
}
