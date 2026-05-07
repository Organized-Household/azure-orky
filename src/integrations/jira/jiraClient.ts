export class JiraClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;

  constructor() {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;

    if (!baseUrl || !email || !apiToken) {
      throw new Error(
        "Missing Jira configuration. Required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN",
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.email = email;
    this.apiToken = apiToken;
  }

  async getIssue(issueId: string): Promise<unknown> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}`;
    console.log('[JiraClient] Fetching issue:', url);
    console.log('[JiraClient] Using email:', this.email);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${this.email}:${this.apiToken}`,
        ).toString("base64")}`,
      },
    });

    console.log('[JiraClient] Response status:', response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[JiraClient] Error body:', errorBody);
      throw new Error(
        `Jira issue fetch failed with status ${response.status}: ${errorBody}`
      );
    }

    const data = await response.json();
    console.log('[JiraClient] Issue key returned:', (data as any)?.key);
    return data;
  }
}