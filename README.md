# GitHub Actions CI/CD Monitor

## Overview

This service monitors GitHub Actions checks for pull requests, detects failed checks, and logs CI/CD status.

## Features

- Monitor GitHub Actions status after PR creation
- Detect failed checks
- Log CI/CD status with detailed information
- Poll for check completion with configurable timeout

## Configuration

Set the following environment variables:

- `GITHUB_TOKEN`: GitHub personal access token with repo access
- `CI_POLLING_INTERVAL`: Polling interval in milliseconds (default: 10000)
- `CI_POLLING_TIMEOUT`: Maximum wait time in milliseconds (default: 300000)
- `LOG_LEVEL`: Logging level (default: 'info')

## Usage

```javascript
const CIMonitor = require('./src/services/ci-monitor');

const monitor = new CIMonitor(process.env.GITHUB_TOKEN);

// Monitor PR checks
const status = await monitor.monitorPullRequestChecks('owner', 'repo', 123);

// Wait for checks to complete
const finalStatus = await monitor.waitForChecksCompletion('owner', 'repo', 123);
```

## Acceptance Criteria

- ✅ GitHub Actions status is monitored after PR creation
- ✅ Failed checks are detected
- ✅ CI/CD status is logged
