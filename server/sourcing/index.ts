import type { DiscoveryQuery, DiscoverySourceId } from '../../shared/discovery';
import { env } from '../env';
import { leadsToRawCandidates } from './normalize';
import { failedResult, liveResult, skippedResult, type SourceRunResult } from './runlog';
import type { SourceAdapter } from './types';
import { githubAdapter } from './adapters/github';
import { secAdapter } from './adapters/sec';
import { sbirAdapter } from './adapters/sbir';
import { rssAdapter } from './adapters/rss';
import { ycAdapter } from './adapters/ycombinator';
import { arxivAdapter } from './adapters/arxiv';
import { productHuntAdapter } from './adapters/producthunt';

/**
 * Source registry + dispatcher. Every adapter uses an official public
 * API or a feed published for consumption; nothing here bypasses
 * paywalls, logins, CAPTCHAs, robots.txt, anti-bot protections, rate
 * limits, or terms of service. Sources with no adapter return zero
 * results and say so — the running application never simulates data.
 */

export const ADAPTERS: Partial<Record<DiscoverySourceId, SourceAdapter>> = {
  github: githubAdapter,
  sec: secAdapter,
  grants: sbirAdapter,
  'funding-news': rssAdapter,
  yc: ycAdapter,
  research: arxivAdapter,
  producthunt: productHuntAdapter,
};

/**
 * Honest source-selection states (Phase 10):
 * - 'live': a real adapter exists and needs no missing credential.
 * - 'credentials-required': a real adapter exists but is currently
 *   missing a required credential — selectable, but the run result
 *   will report it skipped, never faked as succeeding.
 * - 'planned': no adapter exists yet, but one is a reasonable future
 *   addition (a real public API is expected to exist, just not built).
 * - 'unavailable': no adapter exists AND there is no current path to
 *   one (a previously-known API was confirmed retired, or the source
 *   id represents something structurally different from a discovery
 *   adapter, e.g. `websites` is a refresh-verification mechanism).
 */
export type SourceState = 'live' | 'credentials-required' | 'planned' | 'unavailable';

export interface SourceMeta {
  id: DiscoverySourceId;
  name: string;
  state: SourceState;
  /** @deprecated kept for older callers; equivalent to state === 'live'. Use `state` instead. */
  liveCapable: boolean;
  needs: string;
}

/** Recomputed on every call (cheap) so a credential added/removed at runtime is reflected immediately. */
export function getSourceMeta(): SourceMeta[] {
  const meta = (id: DiscoverySourceId, name: string, state: SourceState, needs: string): SourceMeta =>
    ({ id, name, state, liveCapable: state === 'live', needs });

  return [
    meta('github', 'GitHub public API', 'live', 'Nothing (official API, unauthenticated at low rate limits; optional GITHUB_TOKEN raises them).'),
    meta('sec', 'SEC EDGAR (Form D filings)', 'live', 'Outbound network to efts.sec.gov. Set SEC_CONTACT_EMAIL — the SEC asks automated clients to identify themselves.'),
    meta('grants', 'SBIR/STTR government awards', 'live', 'Nothing — public key-free JSON API at api.www.sbir.gov.'),
    meta('funding-news', 'Public funding announcements (RSS)', 'live', 'Outbound network to public RSS feeds (configurable via FUNDING_NEWS_FEEDS). Only parseable funding headlines become leads.'),
    meta('yc', 'Y Combinator public directory', 'live', 'Outbound network to the public YC directory endpoint. No login.'),
    meta('websites', 'Company websites', 'unavailable', 'Not a discovery source — used only by the Settings → Refresh connectors website-reachability check. Selecting it here would return zero results.'),
    meta('accelerators', 'Accelerator & fellowship sites', 'planned', 'Per-program adapters where automated access is permitted — no adapter built yet.'),
    meta('patents', 'Patent databases', 'unavailable', 'PatentsView\'s previously free key-free API was confirmed retired during Phase 9/10 (redirects to the USPTO Open Data Portal, which requires registration, and the newer host does not resolve in DNS). No adapter will be built until a verified current API exists.'),
    meta('research', 'Public research publications (arXiv)', 'live', 'Nothing — public arXiv API (export.arxiv.org), key-free. Leads require a paper to list a non-empty author affiliation, used verbatim — most papers omit this, so honest zeros are common.'),
    meta('hackathons', 'Hackathon & demo-day sites', 'planned', 'Per-event adapters — no adapter built yet.'),
    meta('registries', 'State company registries', 'planned', 'Per-state adapters where legally appropriate — no adapter built yet.'),
    meta('producthunt', 'Product Hunt (authorized only)', env.PRODUCTHUNT_TOKEN ? 'live' : 'credentials-required', 'PRODUCTHUNT_TOKEN (developer token) required — refuses to run without it. Schema built from Product Hunt\'s documented v2 API, not yet exercised against a real token from this environment.'),
    meta('upload', 'User-uploaded CSV/JSON', 'live', 'Nothing — use the Local CSV connector; discovery treats those rows as already imported.'),
    meta('licensed', 'Licensed data (authorized credentials)', 'planned', 'Requires a Vamos-supplied licensed-data agreement — no adapter or credential variable exists yet. Never scraped.'),
  ];
}

// ── Dispatcher ───────────────────────────────────────────────────

type SourceRunner = (sourceId: DiscoverySourceId, q: DiscoveryQuery, remainingApiCalls: number) => Promise<SourceRunResult>;

/** Test-only override so discovery tests can inject fixture sources without network. */
let runnerOverride: SourceRunner | null = null;
export function __setSourceRunnerForTests(runner: SourceRunner | null): void {
  runnerOverride = runner;
}

export async function runSource(sourceId: DiscoverySourceId, q: DiscoveryQuery, remainingApiCalls: number): Promise<SourceRunResult> {
  if (runnerOverride) return runnerOverride(sourceId, q, remainingApiCalls);

  if (sourceId === 'licensed') {
    return skippedResult(sourceId, 'Licensed data requires Vamos-supplied credentials or a user-uploaded export. Skipped — never scraped.', 'missing-credentials');
  }
  if (sourceId === 'upload') {
    return { sourceId, mode: 'local', candidates: [], apiCalls: 0, detail: 'Uploaded CSV/JSON rows enter through the Local CSV connector and are already in the dataset.' };
  }
  if (remainingApiCalls <= 0) {
    return skippedResult(sourceId, 'API-call budget exhausted before this source ran.');
  }

  const adapter = ADAPTERS[sourceId];
  if (!adapter) {
    return skippedResult(sourceId, 'No live adapter is configured for this source — 0 results. Nothing was simulated.', 'not-configured');
  }

  // Real elapsed time for source-quality analytics — never fabricated,
  // and absent entirely (not zero) for a skip where nothing ran.
  const startedAt = Date.now();
  const outcome = await adapter
    .run(q, { maxApiCalls: remainingApiCalls, maxResults: q.maxResults })
    .catch((e: Error) => ({ ok: false as const, failure: 'network' as const, apiCalls: 1, detail: e.message }));
  const durationMs = Date.now() - startedAt;

  if (!outcome.ok) {
    // An adapter that never even attempted a network call because
    // authorization is missing (zero cost) reads as "skipped", the
    // same way a source with no adapter at all does — 'failed' is
    // reserved for a real attempt that didn't go as planned.
    if (outcome.failure === 'missing-credentials' && outcome.apiCalls === 0) {
      return skippedResult(sourceId, outcome.detail, outcome.failure);
    }
    return failedResult(sourceId, outcome.failure, outcome.apiCalls, outcome.detail, durationMs);
  }
  const { candidates, droppedNoCompany } = leadsToRawCandidates(outcome.leads);
  const detail = droppedNoCompany > 0
    ? `${outcome.detail} ${droppedNoCompany} lead(s) without a company name were dropped, not guessed.`
    : outcome.detail;
  return liveResult(sourceId, candidates, outcome.apiCalls, detail, durationMs);
}
