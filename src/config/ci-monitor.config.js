module.exports = {
  polling: {
    interval: parseInt(process.env.CI_POLLING_INTERVAL) || 10000,
    timeout: parseInt(process.env.CI_POLLING_TIMEOUT) || 300000
  },
  github: {
    token: process.env.GITHUB_TOKEN
  },
  logging: {
    enabled: process.env.CI_LOGGING_ENABLED !== 'false',
    level: process.env.LOG_LEVEL || 'info'
  }
};
