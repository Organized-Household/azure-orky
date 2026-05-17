import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';

// Backoff schedule: 5s, 15s, 45s — total max wait = 65s across 3 retries
const BACKOFF_MS = [5_000, 15_000, 45_000];
const MAX_RETRIES = 3;
const TIMEOUT_MS = 120_000;

export type AnthropicRetryCode =
  | 'RATE_LIMIT_EXHAUSTED'
  | 'CREDIT_BALANCE_EXHAUSTED'
  | 'CLIENT_ERROR'
  | 'SERVER_ERROR_EXHAUSTED'
  | 'TIMEOUT';

export interface RetryAttemptInfo {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  errorMessage: string;
}

export class AnthropicRetryExhaustedError extends Error {
  constructor(
    public readonly code: AnthropicRetryCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnthropicRetryExhaustedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCreditBalanceError(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  if (error.status !== 400) return false;
  const body = error.error as Record<string, unknown> | undefined;
  const errorType =
    (body?.error as Record<string, unknown> | undefined)?.type ??
    (body?.type as string | undefined);
  return errorType === 'credit_balance';
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof RateLimitError;
}

function isServerError(error: unknown): boolean {
  return (
    error instanceof InternalServerError ||
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIError && error.status >= 500)
  );
}

function isRetryable(error: unknown): boolean {
  return isRateLimitError(error) || isServerError(error);
}

/**
 * AnthropicRetryClient wraps the Anthropic SDK messages.create() call with:
 * - 429 RateLimitError: retry up to MAX_RETRIES with BACKOFF_MS schedule
 * - 400 credit_balance: fail immediately with required exact message
 * - Other 4xx: fail immediately
 * - 5xx / timeout: retry up to MAX_RETRIES with BACKOFF_MS schedule
 * - Total wait cap: 65s (5+15+45)
 *
 * This client does NOT hold an auditLogger. Retry logging is the caller's
 * responsibility — the caller receives RetryAttemptInfo via the onRetry callback.
 */
export class AnthropicRetryClient {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
    });
  }

  async createMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onRetry?: (info: RetryAttemptInfo) => Promise<void>,
  ): Promise<Anthropic.Message> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const waitMs = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        if (onRetry) {
          await onRetry({
            attempt,
            maxRetries: MAX_RETRIES,
            waitMs,
            errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
          });
        }
        await sleep(waitMs);
      }

      try {
        const response = await this.client.messages.create(
          params,
          { timeout: TIMEOUT_MS },
        );
        return response;
      } catch (error: unknown) {
        if (isCreditBalanceError(error)) {
          throw new AnthropicRetryExhaustedError(
            'CREDIT_BALANCE_EXHAUSTED',
            'Anthropic API credit balance exhausted - execution halted',
            error,
          );
        }

        if (!isRetryable(error)) {
          const isTimeout = error instanceof APIConnectionTimeoutError;
          throw new AnthropicRetryExhaustedError(
            isTimeout ? 'TIMEOUT' : 'CLIENT_ERROR',
            `Anthropic API call failed (non-retryable): ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }

        lastError = error;
      }
    }

    const isRateLimit = lastError instanceof RateLimitError;
    const code: AnthropicRetryCode = isRateLimit
      ? 'RATE_LIMIT_EXHAUSTED'
      : 'SERVER_ERROR_EXHAUSTED';

    throw new AnthropicRetryExhaustedError(
      code,
      `Anthropic API call failed after ${MAX_RETRIES} retries (total wait up to 65s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }
}
