import { audit } from '../lib/guard';
import { runEnrichment } from './enrichment';

/**
 * Background research for companies a reviewer just added by hand.
 *
 * Discovery imports already run the enrichment pass right after import
 * (autoImportRun in ./schedule.ts). Email-intake approvals and CSV imports
 * did not, so their founder/stage/sector cells read "Not yet researched"
 * until someone pressed "Research now" on each company. This runs that
 * same pass — no AI model, no web search — without anyone pressing it.
 *
 * Fire-and-forget: the approval or import has already succeeded and is
 * never held up or undone by research. Ids are coalesced and run one
 * enrichment run at a time, so approving four companies in a row is one
 * or two runs, not four racing each other. A server restart drops what is
 * still queued; those companies simply stay unresearched, as before, and
 * "Research now" still works on them.
 */

/** Same per-company request cap as the "Research now" button (routes/enrichment.ts). */
const REQUESTS_PER_COMPANY = 30;
/** runEnrichment's own default ceiling for a whole run. */
const MAX_REQUESTS_PER_RUN = 600;

let runnerOverride: typeof runEnrichment | null = null;
/** Tests only: substitute the enrichment runner (null restores the default). */
export function setAutoResearchRunnerForTests(runner: typeof runEnrichment | null): void {
  runnerOverride = runner;
}

const pending = new Map<string, string>(); // companyId → actor
let draining: Promise<void> | null = null;

/** Queue companies for background research. Returns immediately. */
export function queueAutoResearch(companyIds: readonly string[], actor: string): void {
  const runner = runnerOverride ?? (process.env.NODE_ENV === 'test' ? null : runEnrichment);
  if (!runner || companyIds.length === 0) return;
  for (const id of companyIds) pending.set(id, actor);
  if (!draining) {
    draining = drain(runner).finally(() => { draining = null; });
  }
}

/** Tests only: resolves once everything queued so far has been researched. */
export function autoResearchIdleForTests(): Promise<void> {
  return draining ?? Promise.resolve();
}

async function drain(runner: typeof runEnrichment): Promise<void> {
  while (pending.size > 0) {
    const batch = [...pending.entries()];
    pending.clear();
    const ids = batch.map(([id]) => id);
    const actors = [...new Set(batch.map(([, actor]) => actor))].join(', ');
    try {
      await runner({
        apply: true,
        companyIds: ids,
        maxRequests: Math.min(MAX_REQUESTS_PER_RUN, REQUESTS_PER_COMPANY * ids.length),
        initiatedBy: `${actors} (auto-research)`,
      });
    } catch (e) {
      audit({
        provider: 'system', mode: 'local', action: 'auto-research-failed', subject: ids.join(','), outcome: 'error',
        detail: `Background research failed for ${ids.length} company/companies: ${(e as Error).message}`,
      });
    }
  }
}
