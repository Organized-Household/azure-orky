import { createOctokit } from './githubClient';

export interface PullRequestResult {
  prUrl: string;
  prNumber: number;
}

export class PullRequestManager {
  async openPullRequest(
    repositoryOwner: string,
    repositoryName: string,
    branchName: string,
    storyId: string,
    storyTitle: string,
    prTitle?: string,
    prBody?: string,
  ): Promise<PullRequestResult> {
    const octokit = createOctokit();
    const title = prTitle ?? `[${storyId}] ${storyTitle.replace(/\r?\n/g, ' ').slice(0, 72)}`;
    const body = prBody ?? `Automated PR created by Orky for story ${storyId}.\n\n**Story:** ${storyTitle}`;
    const response = await octokit.pulls.create({
      owner: repositoryOwner,
      repo: repositoryName,
      title,
      head: branchName,
      base: 'dev',
      body,
    });
    return {
      prUrl: response.data.html_url,
      prNumber: response.data.number,
    };
  }
}
