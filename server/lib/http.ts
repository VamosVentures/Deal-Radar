/** Outbound-call helpers: hard timeout + one retry on transient errors. */

import dns from 'node:dns';

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^169\.254\./,                // link-local — also covers cloud metadata (169.254.169.254)
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fe80:/i,
  /\.(local|internal)$/i,
];

/**
 * SSRF guard, string-literal check only. Rejects non-http(s) schemes
 * and hostnames that are loopback/private/link-local/cloud-metadata
 * literals — instant, no network call, but does NOT catch a public
 * hostname that resolves to a private address (DNS rebinding). Prefer
 * isSafeExternalUrlResolved() for anything actually being fetched;
 * this sync form remains for callers that just need a quick literal
 * check (e.g. as a fast pre-filter) or can't await a DNS lookup.
 */
export function isSafeExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return !PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(host));
}

/**
 * SSRF guard, resolution-aware. Closes the gap in isSafeExternalUrl:
 * after the same literal check, resolves the hostname and rejects it
 * if ANY resolved address is loopback/private/link-local/cloud-
 * metadata — catching a public-looking hostname that actually points
 * at internal infrastructure. A lookup failure is treated as unsafe
 * (can't verify, so don't fetch).
 *
 * Still not airtight: the resolved address isn't pinned for the
 * actual fetch that follows, so a narrow TOCTOU window remains if DNS
 * changes between this check and the request (true DNS-rebinding
 * protection requires connecting to the checked IP directly, which
 * would need a custom fetch agent). Documented in KNOWN_LIMITATIONS.md.
 */
export async function isSafeExternalUrlResolved(raw: string, timeoutMs = 3000): Promise<boolean> {
  if (!isSafeExternalUrl(raw)) return false;
  const host = new URL(raw).hostname;
  let addresses: string[];
  try {
    const lookup = dns.promises.lookup(host, { all: true });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs));
    addresses = (await Promise.race([lookup, timeout])).map((a) => a.address);
  } catch {
    return false; // can't resolve (or too slow) → can't verify → refuse
  }
  if (addresses.length === 0) return false;
  return addresses.every((ip) => !PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(ip)));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Retry once on 429/5xx or a network failure, with a short backoff. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const attempt = () => fetchWithTimeout(url, init, timeoutMs);
  try {
    const res = await attempt();
    if (res.status === 429 || res.status >= 500) {
      await sleep(750);
      return await attempt();
    }
    return res;
  } catch (first) {
    await sleep(500);
    try {
      return await attempt();
    } catch {
      throw first;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
