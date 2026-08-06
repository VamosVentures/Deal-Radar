#!/usr/bin/env -S npx tsx
/**
 * Materialize the four researched pilot candidates into the LOCAL
 * development database, through the normal pipeline.
 *
 *   npm run pilot:finalize -- --dry-run     # report only, writes nothing
 *   npm run pilot:finalize                  # apply
 *
 * WHAT THIS IS FOR
 *
 * Four YC companies had been researched in an isolated preview
 * (scripts/candidate-diligence.ts) and never reached the pilot database,
 * so `pending_evidence` held zero rows and the analyst panel had nothing
 * to show for any company. This walks them through the same path a
 * discovery run uses — persisted candidate → importCandidates →
 * runEnrichment(apply) — rather than writing company rows directly. That
 * matters because every invariant lives on that path: duplicate
 * detection, provenance, discovery-run attribution, review status,
 * founder resolution and the pending-evidence queue.
 *
 * IDENTITY IS THE CANONICAL DOMAIN, NEVER THE NAME
 *
 * The YC directory lists both "Manifold" (warehouse robotics, S26,
 * manifoldindustries.ai) and "Manifold Freight" (W24,
 * manifoldfreight.com). They are different companies. Every lookup and
 * every match below is on the normalized domain key, so the two can
 * never be conflated and neither can be created twice from a difference
 * in punctuation, casing, `www`, or a URL path.
 *
 * WHAT IT WILL NOT DO
 *
 * No company is approved, passed, synced or marked High-Fit. No traction
 * or stage rating is recorded — those are analyst judgements, and the
 * evidence this queues is left `pending` for a person to accept, edit or
 * reject. Nobody is contacted. Re-running changes nothing: every write
 * is keyed so a second pass inserts no duplicate candidate, company,
 * founder, evidence row or score.
 */
import { runDiscovery, importCandidates, existingCandidates } from '../server/services/discovery';
import { runEnrichment } from '../server/services/enrichment';
import { listPendingEvidence } from '../server/services/pendingEvidence';
import { normalizeDomainKey } from '../server/sourcing/identity';
import { getDb } from '../server/db/client';
import { latestScore } from '../server/db/repos/operations';
import type { DiscoveryCandidate } from '../shared/discovery';
import type { VerticalId } from '../src/types';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * The four, with the domain that IS their identity and the search term
 * that surfaces them in the public YC directory. `vertical` is the
 * vertical whose sweep is used to find them; the classifier still
 * decides the stored vertical, and this value never overrides it.
 */
interface Target {
  label: string;
  domain: string;
  term: string;
  vertical: VerticalId;
  /** Why a partner may need to rule on this one before it advances. */
  mandateNote?: string;
}

const TARGETS: Target[] = [
  { label: 'Manifold', domain: 'manifoldindustries.ai', term: 'Manifold', vertical: 'frontier' },
  { label: 'Grade', domain: 'usegrade.com', term: 'Grade', vertical: 'fintech' },
  {
    label: 'Unifold', domain: 'unifold.io', term: 'Unifold', vertical: 'fintech',
    mandateNote:
      'Multi-chain crypto deposit/payment infrastructure. Sits in the FinTech "DeFi & blockchain" '
      + 'subcategory, which the taxonomy marks as an adjacent/exception category that may conflict '
      + 'with current firm exclusions. REQUIRES an explicit partner mandate ruling before it '
      + 'advances — do not treat its presence in the pipeline as an in-mandate decision.',
  },
  { label: 'Scheduling Wizard', domain: 'schedulingwiz.com', term: 'Scheduling Wizard', vertical: 'health' },
];

const key = (d: string) => normalizeDomainKey(d)!;

/** Does a company with this canonical domain already exist? Read-only. */
function existingByDomain(domain: string): { id: string; name: string; website: string | null } | null {
  const want = key(domain);
  const rows = getDb().prepare('SELECT id, name, website FROM companies').all() as
    { id: string; name: string; website: string | null }[];
  return rows.find((r) => normalizeDomainKey(r.website) === want) ?? null;
}

function line(label: string, value: string) {
  console.log(`   ${label.padEnd(30, '.')} ${value}`);
}

interface Report {
  label: string;
  domain: string;
  action: 'already-present' | 'imported' | 'not-found' | 'import-failed' | 'would-import';
  companyId: string | null;
  detail: string;
}

async function main() {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Pilot candidate finalization — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log('='.repeat(72));

  const reports: Report[] = [];
  const toEnrich: string[] = [];

  for (const t of TARGETS) {
    console.log(`\n── ${t.label}  (${t.domain}) ──`);

    const existing = existingByDomain(t.domain);
    if (existing) {
      /**
       * Already on record. Nothing is re-created — the enrichment pass
       * below still runs for it, and every write in that pass is
       * idempotent, so new public evidence is attached to the SAME
       * company rather than producing a second one.
       */
      line('already on record', `${existing.name} (${existing.id})`);
      reports.push({
        label: t.label, domain: t.domain, action: 'already-present', companyId: existing.id,
        detail: `Matched on canonical domain ${key(t.domain)}. Not re-created.`,
      });
      toEnrich.push(existing.id);
      continue;
    }

    /**
     * A REAL run, not a preview: a preview deliberately persists no
     * candidate, and importCandidates can only import a candidate that
     * exists. Scoped as narrowly as the source allows — one source
     * family, one search term — so this is a targeted lookup rather than
     * a wide sweep.
     */
    const run = await runDiscovery({
      vertical: t.vertical,
      terms: [t.term],
      sources: ['yc'],
      maxResults: 20,
      maxApiCalls: 2,
      geography: 'United States',
      mode: 'all',
      dateFrom: '2024-01-01',
    }, 'pilot-finalize', 'manual');

    line('discovery run', `${run.id} — ${run.status}`);

    /**
     * Match on DOMAIN. Matching the returned candidates by name here is
     * the specific mistake this guards against: the same sweep that
     * returns Manifold also returns Manifold Freight, and a name match
     * would attribute one company's founders and evidence to the other.
     */
    const want = key(t.domain);
    // Candidates persisted by this run, read back from the store — a real
    // run returns run metadata, not the rows.
    const candidates = (existingCandidates() as DiscoveryCandidate[]).filter((c) => c.runId === run.id);
    const hit = candidates.find((c) => normalizeDomainKey(c.website) === want);
    const nameAlike = candidates.filter(
      (c) => c.companyName.toLowerCase().includes(t.term.toLowerCase()) && normalizeDomainKey(c.website) !== want,
    );
    if (nameAlike.length > 0) {
      line('same-name, different co', nameAlike.map((c) => `${c.companyName} (${c.website})`).join('; '));
      console.log('      ^ deliberately NOT matched — identity is the domain, not the name.');
    }

    if (!hit) {
      line('result', 'NOT FOUND by canonical domain in this run');
      reports.push({
        label: t.label, domain: t.domain, action: 'not-found', companyId: null,
        detail: `No candidate in run ${run.id} carries domain ${want}. `
          + `${candidates.length} candidate(s) returned. Nothing was created — a company is not `
          + 'invented because it was expected.',
      });
      continue;
    }

    line('candidate', `${hit.id} — ${hit.companyName}`);
    line('candidate website', String(hit.website));
    line('vertical (classifier)', hit.vertical);
    line('duplicate status', `${hit.duplicateStatus}${hit.duplicateOfName ? ` of ${hit.duplicateOfName}` : ''}`);
    line('thesis eligible', String(hit.thesisEligible));
    line('founders on candidate', String(hit.founderNames.length));

    if (DRY_RUN) {
      reports.push({
        label: t.label, domain: t.domain, action: 'would-import', companyId: null,
        detail: `Candidate ${hit.id} found and would be imported.`,
      });
      continue;
    }

    /**
     * `duplicateAction: 'skip'` on purpose. If the pipeline thinks this
     * is a duplicate of something already on record, the right outcome is
     * a review item, not a second row — creating one anyway is exactly
     * the failure this whole exercise is meant to avoid.
     */
    const outcome = importCandidates({ candidateIds: [hit.id], duplicateAction: 'skip' });
    if (outcome.counts.imported !== 1) {
      const why = outcome.skipped[0]?.reason ?? outcome.failed[0]?.reason ?? 'unknown';
      line('import', `NOT imported — ${why}`);
      reports.push({
        label: t.label, domain: t.domain, action: 'import-failed', companyId: null,
        detail: `importCandidates declined: ${why}`,
      });
      continue;
    }
    /**
     * Re-read by DOMAIN rather than trusting a returned id. This both
     * yields the company id and proves the write landed on the intended
     * canonical identity.
     */
    const created = existingByDomain(t.domain);
    if (!created) {
      line('import', 'reported imported, but no company carries this domain');
      reports.push({
        label: t.label, domain: t.domain, action: 'import-failed', companyId: null,
        detail: 'importCandidates reported success but no row matches the canonical domain.',
      });
      continue;
    }
    line('imported as', `${created.name} (${created.id})`);
    reports.push({
      label: t.label, domain: t.domain, action: 'imported', companyId: created.id,
      detail: `Imported from candidate ${hit.id} in run ${run.id}.`,
    });
    toEnrich.push(created.id);
  }

  /**
   * One enrichment pass over exactly these companies. This is what reads
   * the public YC profile, resolves founders from its DOM structure, and
   * queues the company-claimed sentences as pending evidence. It applies
   * no traction and no analyst decision.
   */
  if (!DRY_RUN && toEnrich.length > 0) {
    console.log(`\n── Enriching ${toEnrich.length} company/companies (founders + pending evidence) ──`);
    const res = await runEnrichment({
      apply: true,
      companyIds: toEnrich,
      initiatedBy: 'pilot-finalize',
      maxRequests: 24 * toEnrich.length,
      onProgress: (l) => console.log(`   ${l}`),
    });
    console.log(`   run ${res.runId} — ${res.status}, ${res.requestsSpent} request(s) spent`);
  }

  // ── Report ──────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(72)}`);
  console.log('RESULT');
  console.log('='.repeat(72));
  for (const r of reports) {
    console.log(`\n${r.label}  [${r.action}]`);
    console.log(`   domain ......... ${key(r.domain)}`);
    console.log(`   detail ......... ${r.detail}`);
    if (!r.companyId) continue;

    const db = getDb();
    const row = db.prepare('SELECT name, website, vertical, stage, review_status, discovery_source FROM companies WHERE id = ?')
      .get(r.companyId) as Record<string, unknown> | undefined;
    if (row) {
      console.log(`   stored ......... ${row.name} | ${row.website} | vertical=${row.vertical} | stage=${row.stage}`);
      console.log(`   review status .. ${row.review_status ?? 'New'}  (analyst decision pending — NOT approved)`);
      console.log(`   discovery src .. ${row.discovery_source ?? 'none'}`);
    }
    const founders = db.prepare('SELECT name, role FROM founders WHERE company_id = ? ORDER BY id').all(r.companyId) as
      { name: string; role: string }[];
    console.log(`   founders (${founders.length}) ... ${founders.map((f) => `${f.name} [${f.role}]`).join('; ') || '—'}`);

    const pending = listPendingEvidence(r.companyId);
    const about = pending.filter((p) => p.aboutThisCompany);
    const prior = pending.filter((p) => !p.aboutThisCompany);
    console.log(`   pending evidence ${pending.length} (${about.length} about this company, ${prior.length} prior-company/founder)`);
    for (const p of pending) {
      console.log(`     - [${p.kind}/${p.section}] about=${p.aboutThisCompany} suggested=${p.suggestedState ?? 'none'} :: ${p.quote.slice(0, 120)}`);
    }
    const score = latestScore(r.companyId);
    console.log(`   latest score ... ${score ? `${score.score} (provisional=${score.provisional}, completeness=${score.completeness})` : 'none'}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('MANDATE / POLICY NOTES REQUIRING A HUMAN RULING');
  console.log('='.repeat(72));
  for (const t of TARGETS.filter((x) => x.mandateNote)) {
    console.log(`\n${t.label}: ${t.mandateNote}`);
  }
  console.log('\nNo traction rating, stage rating, approval, pass, or CRM sync was recorded by this script.');
}

main().catch((e) => {
  console.error(`\nFinalization failed: ${(e as Error).message}`);
  console.error((e as Error).stack);
  process.exit(1);
});
