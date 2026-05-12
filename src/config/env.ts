import dotenv from 'dotenv';

dotenv.config();

export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  JIRA_API_URL: string;
  JIRA_API_TOKEN: string;
  JIRA_PROJECT_KEY: string;
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO: string;
  FORGE_API_URL: string;
  FORGE_API_KEY: string;
  FORGE_MODEL: string;
  FORGE_MAX_TOKENS: number;
  FORGE_TIMEOUT_MS: number;
}

export interface ForgeConfig {
  url: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export function getEnv(): EnvConfig {
  const missing: string[] = [];

  const get = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  };

  const getInt = (key: string, defaultValue: number): number => {
    const value = process.env[key];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be a valid integer`);
    }
    return parsed;
  };

  const config: EnvConfig = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: getInt('PORT', 3000),
    DATABASE_URL: get('DATABASE_URL'),
    JIRA_API_URL: get('JIRA_API_URL'),
    JIRA_API_TOKEN: get('JIRA_API_TOKEN'),
    JIRA_PROJECT_KEY: get('JIRA_PROJECT_KEY'),
    GH_TOKEN: get('GH_TOKEN'),
    GH_OWNER: get('GH_OWNER'),
    GH_REPO: get('GH_REPO'),
    FORGE_API_URL: get('FORGE_API_URL'),
    FORGE_API_KEY: get('FORGE_API_KEY'),
    FORGE_MODEL: process.env.FORGE_MODEL || 'claude-3-7-sonnet-20250219',
    FORGE_MAX_TOKENS: getInt('FORGE_MAX_TOKENS', 200000),
    FORGE_TIMEOUT_MS: getInt('FORGE_TIMEOUT_MS', 120000)
  };

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return config;
}
