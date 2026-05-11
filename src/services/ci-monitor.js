const { Octokit } = require('@octokit/rest');
const logger = require('../utils/logger');

class CIMonitor {
  constructor(githubToken) {
    this.octokit = new Octokit({ auth: githubToken });
  }

  async monitorPullRequestChecks(owner, repo, pullNumber) {
    try {
      logger.info(`Monitoring CI/CD status for PR #${pullNumber}`);
      
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber
      });

      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: pr.head.sha
      });

      const status = this.analyzeChecks(checkRuns.check_runs);
      this.logCIStatus(pullNumber, status);
      
      return status;
    } catch (error) {
      logger.error(`Failed to monitor PR checks: ${error.message}`);
      throw error;
    }
  }

  analyzeChecks(checkRuns) {
    const failedChecks = checkRuns.filter(check => check.conclusion === 'failure');
    const pendingChecks = checkRuns.filter(check => check.status !== 'completed');
    
    return {
      total: checkRuns.length,
      failed: failedChecks.length,
      pending: pendingChecks.length,
      passed: checkRuns.filter(check => check.conclusion === 'success').length,
      failedChecks: failedChecks.map(check => ({
        name: check.name,
        conclusion: check.conclusion,
        detailsUrl: check.details_url
      })),
      allPassed: failedChecks.length === 0 && pendingChecks.length === 0
    };
  }

  logCIStatus(pullNumber, status) {
    logger.info(`CI/CD Status for PR #${pullNumber}:`, {
      total: status.total,
      passed: status.passed,
      failed: status.failed,
      pending: status.pending,
      allPassed: status.allPassed
    });

    if (status.failed > 0) {
      logger.warn(`Detected ${status.failed} failed check(s):`, status.failedChecks);
    }
  }

  async waitForChecksCompletion(owner, repo, pullNumber, timeout = 300000, interval = 10000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const status = await this.monitorPullRequestChecks(owner, repo, pullNumber);
      
      if (status.pending === 0) {
        return status;
      }
      
      logger.info(`Waiting for ${status.pending} pending check(s)...`);
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error('Timeout waiting for checks to complete');
  }
}

module.exports = CIMonitor;
