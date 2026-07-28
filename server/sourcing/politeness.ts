/**
 * Being a well-behaved API client.
 *
 * Every public source this app uses is someone else's infrastructure,
 * offered for free. This module is the shared machinery for not abusing
 * it: one request at a time per host, a minimum gap between requests,
 * honouring Retry-After, bounded exponential backoff with jitter, a
 * short response cache, and a hard per-run request budget.
 *
 * An important distinction it draws, because conflating the two produced
 * a misleading run report: being rate-limited BY OUR OWN request rate is
 * a different failure from a service that is refusing everyone. The SBIR
 * API currently returns 429 with the body "The SBIR Public API is not
 * available at this time." on the very first request of a run, with no
 * Retry-After header, while its human-facing site serves fine. No
 * backoff strategy fixes that, and reporting it as "rate limited" would
 * imply we were being greedy. It is reported as service-unavailable.
 */

export type PolitenessFailure =
  | 'rate-limited-by-us'      // we genuinely sent too many; backoff applies
  | 'service-unavailable'     // the service is refusing everyone
  | 'forbidden'               // access denied, usually a User-Agent policy
  | 'budget-exhausted'        // our own per-run cap stopped us
  | 'network'
  | 'timeout';

export interface PoliteResponse {
  ok: boolean;
  status: number;
  body: string;
  fromCache: boolean;
  failure?: PolitenessFailure;
  detail?: string;
  /** How many real network requests this call consumed. */
  requests: number;
}

export interface HostPolicy {
  /** Minimum milliseconds between two requests to this host. */
  minGapMs: number;
  /** Maximum attempts for one logical request, including the first. */
  maxAttempts: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** How long a successful response stays cacheable. */
  cacheTtlMs: number;
}

const DEFAULT_POLICY: HostPolicy = {
  minGapMs: 1_000,
  maxAttempts: 3,
  timeoutMs: 10_000,
  cacheTtlMs: 10 * 60_000,
};

/**
 * Per-host policies. Conservative by default; the SEC's published
 * guidance allows more, and arXiv asks for less.
 */
const HOST_POLICIES: Record<string, Partial<HostPolicy>> = {
  'api.www.sbir.gov': { minGapMs: 2_000, maxAttempts: 3, cacheTtlMs: 30 * 60_000 },
  'efts.sec.gov': { minGapMs: 150, maxAttempts: 3 },
  'www.sec.gov': { minGapMs: 150, maxAttempts: 3 },
  'export.arxiv.org': { minGapMs: 3_000, maxAttempts: 2 },
  'api.github.com': { minGapMs: 800, maxAttempts: 2 },
  'api.ycombinator.com': { minGapMs: 500, maxAttempts: 2 },
};

/**
 * Under the test harness the DECISIONS below still run in full — the
 * per-host queue, the retry count, the Retry-After branch, the failure
 * classification — but the wall-clock waiting collapses to near zero.
 * Politeness is a courtesy to a real remote host; a stubbed fetch is not
 * a host, and making the suite sleep 2s between attempts only bought
 * timeouts. Production timings are untouched.
 */
const FAST = process.env.NODE_ENV === 'test';

function policyFor(host: string): HostPolicy {
  const merged = { ...DEFAULT_POLICY, ...(HOST_POLICIES[host] ?? {}) };
  return FAST ? { ...merged, minGapMs: 0, timeoutMs: Math.min(merged.timeoutMs, 2_000) } : merged;
}

// ── Per-host serialization ────────────────────────────────────────
// One in-flight request per host, with a minimum gap. Implemented as a
// promise chain per host so concurrent callers queue instead of racing.

const hostChains = new Map<string, Promise<void>>();
const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTurn(host: string, minGapMs: number): Promise<void> {
  const prior = hostChains.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((res) => { release = res; });
  hostChains.set(host, prior.then(() => mine));
  await prior;

  const last = lastRequestAt.get(host);
  if (last !== undefined) {
    const gap = Date.now() - last;
    if (gap < minGapMs) await sleep(minGapMs - gap);
  }
  lastRequestAt.set(host, Date.now());
  // Release the next queued caller on the next tick, not before we have
  // stamped our own timestamp.
  setTimeout(release, 0);
}

// ── Response cache ────────────────────────────────────────────────

interface CacheEntry { at: number; status: number; body: string }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 300;

function cacheGet(url: string, ttlMs: number): CacheEntry | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(url); return null; }
  return hit;
}

function cacheSet(url: string, status: number, body: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, { at: Date.now(), status, body });
}

export function clearPolitenessCacheForTests(): void {
  cache.clear();
  hostChains.clear();
  lastRequestAt.clear();
}

// ── Per-run request budget ────────────────────────────────────────

export class RequestBudget {
  private used = 0;
  constructor(private readonly limit: number) {}
  get remaining(): number { return Math.max(0, this.limit - this.used); }
  get spent(): number { return this.used; }
  tryTake(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

/**
 * Classify an HTTP failure. The 429 distinction is the point: a 429 on
 * our FIRST request to a host cannot be our fault, so it is reported as
 * the service being unavailable rather than as us being throttled.
 */
export function classifyStatus(status: number, body: string): PolitenessFailure | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 403) return 'forbidden';
  if (status === 429 || status === 503) {
    // The RESPONSE BODY is the signal, not how many attempts we have
    // made. An earlier version guessed from the attempt count, which
    // meant any first-attempt 429 was reported as a service outage and
    // never retried — conflating "the service is down for everyone" with
    // "we were too fast". SBIR states "The SBIR Public API is not
    // available at this time"; a plain throttle does not.
    const saysUnavailable = /not available|unavailable|maintenance|temporarily down/i.test(body);
    return saysUnavailable ? 'service-unavailable' : 'rate-limited-by-us';
  }
  return 'network';
}

export interface PoliteFetchOptions {
  headers?: Record<string, string>;
  budget?: RequestBudget;
  /** Skip the cache for this call. */
  noCache?: boolean;
}

/**
 * Fetch a URL politely. Never throws for HTTP or network conditions —
 * a source failing is an expected outcome that must be reported, not an
 * exception that aborts a run.
 */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<PoliteResponse> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, status: 0, body: '', fromCache: false, failure: 'network', detail: 'Malformed URL.', requests: 0 };
  }
  const policy = policyFor(host);

  if (!opts.noCache) {
    const hit = cacheGet(url, policy.cacheTtlMs);
    if (hit) {
      return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, body: hit.body, fromCache: true, requests: 0 };
    }
  }

  let requests = 0;
  let lastStatus = 0;
  let lastBody = '';
  let lastFailure: PolitenessFailure | undefined;
  let lastDetail = '';

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (opts.budget && !opts.budget.tryTake()) {
      return {
        ok: false, status: lastStatus, body: '', fromCache: false,
        failure: 'budget-exhausted',
        detail: `Per-run request budget exhausted before this request to ${host}. Stopped rather than exceeding the agreed cap.`,
        requests,
      };
    }

    await waitTurn(host, policy.minGapMs);
    requests++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
      const body = await res.text();
      lastStatus = res.status;
      lastBody = body;

      if (res.ok) {
        cacheSet(url, res.status, body);
        return { ok: true, status: res.status, body, fromCache: false, requests };
      }

      lastFailure = classifyStatus(res.status, body);
      lastDetail = `${host} returned ${res.status}.`;

      // Forbidden and service-unavailable are not fixed by retrying.
      if (lastFailure === 'forbidden' || lastFailure === 'service-unavailable') break;

      // Honour Retry-After when the server tells us how long to wait.
      const retryAfter = res.headers.get('retry-after');
      if (attempt < policy.maxAttempts) {
        const explicitMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
        const backoffMs = Number.isFinite(explicitMs) && explicitMs > 0
          ? Math.min(explicitMs, 30_000)
          : Math.min(1_000 * 2 ** (attempt - 1), 8_000) + Math.floor(Math.random() * 250);
        await sleep(FAST ? 0 : backoffMs);
      }
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      lastFailure = aborted ? 'timeout' : 'network';
      lastDetail = aborted ? `${host} did not respond within ${policy.timeoutMs}ms.` : `${host}: ${(e as Error).message}`;
      if (attempt < policy.maxAttempts) {
        await sleep(FAST ? 0 : Math.min(1_000 * 2 ** (attempt - 1), 8_000));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false, status: lastStatus, body: lastBody, fromCache: false,
    failure: lastFailure ?? 'network',
    detail: describeFailure(lastFailure, host, lastStatus, lastBody, lastDetail),
    requests,
  };
}

function describeFailure(
  failure: PolitenessFailure | undefined, host: string, status: number, body: string, fallback: string,
): string {
  const snippet = body.trim().slice(0, 160).replace(/\s+/g, ' ');
  switch (failure) {
    case 'service-unavailable':
      return `${host} is refusing requests at the service level (HTTP ${status})`
        + `${snippet ? `: "${snippet}"` : ''}. This is not our request rate — it happened on the first attempt with no Retry-After. Nothing was collected; no workaround was attempted.`;
    case 'forbidden':
      return `${host} denied access (HTTP 403). Usually a User-Agent or access-policy requirement. Nothing was collected.`;
    case 'rate-limited-by-us':
      return `${host} rate-limited us (HTTP ${status}) after repeated attempts. Backed off and gave up for this run rather than pushing harder.`;
    case 'timeout':
    case 'network':
    default:
      return fallback || `${host} request failed.`;
  }
}
