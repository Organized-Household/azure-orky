import { Octokit } from '@octokit/rest';

export function createOctokit(): Octokit {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GH_TOKEN environment variable is not set');
  }
  return new Octokit({ auth: token });
}
