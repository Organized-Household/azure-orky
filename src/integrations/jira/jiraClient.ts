export class JiraClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;

  constructor(
    baseUrl?: string,
    email?: string,
    apiToken?: string,
  ) {
    const resolvedBaseUrl = baseUrl ?? process.env.JIRA_BASE_URL;
    const resolvedEmail = email ?? process.env.JIRA_EMAIL;
    const resolvedApiToken = apiToken ?? process.env.JIRA_API_TOKEN;

    if (!resolvedBaseUrl || !resolvedEmail || !resolvedApiToken) {
      throw new Error(
        'Missing Jira configuration. Required: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (via constructor params or env vars)',
      );
    }

    this.baseUrl = resolvedBaseUrl.replace(/\/+$/, '');
    this.email = resolvedEmail;
    this.apiToken = resolvedApiToken;
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`,
      },
      body: JSON.stringify({ transition: { id: transitionId } }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Jira transition failed for ${issueKey} (transitionId=${transitionId}): ${response.status} ${errorBody}`,
      );
    }
  }

  async addComment(issueKey: string, bodyText: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`,
      },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: bodyText }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Jira add comment failed for ${issueKey}: ${response.status} ${errorBody}`);
    }
  }

  async addRemoteLink(issueKey: string, linkUrl: string, title: string): Promise<void> {
    const apiUrl = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`,
      },
      body: JSON.stringify({ object: { url: linkUrl, title } }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Jira add remote link failed for ${issueKey}: ${response.status} ${errorBody}`,
      );
    }
  }

  async addLabel(issueKey: string, label: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`,
      },
      body: JSON.stringify({ update: { labels: [{ add: label }] } }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Jira add label failed for ${issueKey}: ${response.status} ${errorBody}`);
    }
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