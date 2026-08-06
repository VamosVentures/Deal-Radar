/**
 * Generic retry-with-backoff-and-jitter helper. Used today by
 * server/sourcing/index.ts (runSource) to retry a source adapter call
 * once or twice on a transient failure before it's recorded as
 * genuinely failed — a single dropped connection or timeout previously
 * cost a source its entire run. Reusable as-is for future per-adapter
 * retry needs (see SOURCING_PIPELINE_ROADMAP.md).
 */

export interface RetryOptions<T> {
  /** Total attempts including the first — default 3 (i.e. up to 2 retries). */
  maxAttempts?: number;
  /** Base backoff in ms before the 2nd attempt; doubles each subsequent attempt. */
  baseMs?: number;
  /** Backoff is capped here regardless of attempt count. */
  maxMs?: number;
  /**
   * Decide whether a RESOLVED (not thrown) result should be retried —
   * e.g. an adapter that returns `{ ok: false, failure: 'timeout' }`
   * instead of throwing. A thrown exception is always treated as
   * retriable (matching the existing network-error fallback).
   */
  isRetriable?: (result: T) => boolean;
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return backoff + Math.random() * backoff * 0.5; // up to +50% jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions<T> = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 2000;
  const isRetriable = opts.isRetriable ?? (() => false);

  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      lastResult = await fn();
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      await sleep(backoffDelay(attempt, baseMs, maxMs));
      continue;
    }
    if (attempt === maxAttempts || !isRetriable(lastResult)) return lastResult;
    await sleep(backoffDelay(attempt, baseMs, maxMs));
  }
  // Unreachable given maxAttempts >= 1, but keeps the return type sound.
  return lastResult as T;
}
