/**
 * Typed failure states for source adapters. Every failure is surfaced
 * honestly in the run log — a failed source contributes zero leads and
 * never falls back to sample data.
 */
export type SourceFailureKind =
  | 'timeout'
  | 'rate-limited'
  | 'http-error'
  | 'invalid-response'
  | 'network'
  | 'missing-credentials'
  | 'not-configured';

export function failureLabel(kind: SourceFailureKind): string {
  switch (kind) {
    case 'timeout': return 'Timed out';
    case 'rate-limited': return 'Rate limited';
    case 'http-error': return 'HTTP error';
    case 'invalid-response': return 'Invalid response';
    case 'network': return 'Network unreachable';
    case 'missing-credentials': return 'Missing credentials';
    case 'not-configured': return 'No adapter configured';
  }
}

/** Classify a thrown fetch error (AbortError = our timeout fired). */
export function classifyFetchError(e: unknown): { kind: SourceFailureKind; message: string } {
  const err = e as Error & { name?: string; cause?: { code?: string } };
  if (err?.name === 'AbortError') {
    return { kind: 'timeout', message: 'The request exceeded the timeout and was aborted.' };
  }
  return { kind: 'network', message: err?.message ?? 'Network request failed.' };
}

/** Classify a non-OK HTTP response, detecting rate limiting where the API signals it. */
export function classifyHttpStatus(res: Response): { kind: SourceFailureKind; message: string } {
  if (res.status === 429) {
    return { kind: 'rate-limited', message: 'The source returned 429 Too Many Requests. Backing off — no data collected this run.' };
  }
  // GitHub signals rate limiting as 403 with a zeroed remaining header.
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'rate-limited', message: 'The source rate limit is exhausted (403, x-ratelimit-remaining: 0). Try again later.' };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'missing-credentials', message: `The source rejected the request (${res.status}) — credentials are missing or not authorized.` };
  }
  return { kind: 'http-error', message: `The source returned HTTP ${res.status}.` };
}
