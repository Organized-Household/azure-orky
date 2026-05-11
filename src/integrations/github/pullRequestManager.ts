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
  ): Promise<PullRequestResult> {
    const octokit = createOctokit();
    const safeTitle = storyTitle.replace(/\r?\n/g, ' ').slice(0, 72);
    const response = await octokit.pulls.create({
      owner: repositoryOwner,
      repo: repositoryName,
      title: `[${storyId}] ${safeTitle}`,
      head: branchName,
      base: 'dev',
      body: `Automated PR created by Orky for story ${storyId}.\n\n**Story:** ${safeTitle}`,
    });
    return {
      prUrl: response.data.html_url,
      prNumber: response.data.number,
    };
  }
}
