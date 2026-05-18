import { Octokit } from '@octokit/rest';

export function createOctokit(token?: string): Octokit {
  const resolvedToken = token ?? process.env.GH_TOKEN;
  if (!resolvedToken) {
    throw new Error('GH_TOKEN environment variable is not set and no token provided');
  }
  return new Octokit({ auth: resolvedToken });
}
