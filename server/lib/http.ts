/** Outbound-call helpers: hard timeout + one retry on transient errors. */

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
