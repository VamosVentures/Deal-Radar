/**
 * Source diversified, evidence-backed opportunities — one sector at a
 * time, from multiple source families.
 *
 * This replaces the previous populate script's approach of taking five
 * arbitrary Y Combinator companies per sector. It leads with SEC Form D
 * (tier 1, a dated regulatory record of an actual offering), adds
 * funding-news and accelerator evidence, and lets the classifier decide
 * what counts as a current opportunity.
 *
 * It never deletes anything. Existing companies stay; new evidence is
 * appended; classifications are recomputed. A sector that cannot fill
 * five slots shows fewer.
 *
 * Usage: npx tsx scripts/source-opportunities.ts [--per-sector 5] [--dry-run]
 */

import { runSource } from '../server/sourcing';
import { addDealEvidence, reclassifyCompany } from '../server/db/repos/opportunities';
import { listCompanies, saveCompany, matchRecords } from '../server/db/repos/companies';
import { saveScore } from '../server/db/repos/operations';
import { matchCompany } from '../server/sourcing/identity';
import { checkEntityType, classifyCandidate } from '../server/sourcing/classify';
import { candidateToDealEvidence, buildShortlists, overallDiversity } from '../server/services/shortlist';
import { importedCompanySchema } from '../server/services/imports';
import { scoreCompany } from '../src/lib/scoring';
import { VERTICALS } from '../src/data/taxonomy';
import { tierOf } from '../shared/opportunity';
import type { VerticalId, Company } from '../src/types';
import type { DiscoveryQuery } from '../shared/discovery';
import type { RawCandidate } from '../server/sourcing/normalize';

const args = process.argv.slice(2);
const PER_SECTOR = Number(args[args.indexOf('--per-sector') + 1]) || 5;
const DRY_RUN = args.includes('--dry-run');

/**
 * Per-sector search terms per source. SEC full-text search matches the
 * words in a filing, so sector nouns work well there; YC matches its own
 * tags.
 */
const SECTOR_TERMS: Record<VerticalId, string[]> = {
  health: ['health', 'healthcare', 'medical', 'clinical', 'therapeutics'],
  fintech: ['fintech', 'payments', 'lending', 'insurance technology'],
  fow: ['workforce', 'recruiting', 'human resources software', 'productivity software'],
  sustainability: ['climate', 'renewable energy', 'solar', 'carbon'],
  frontier: ['robotics', 'automation', 'space', 'satellite'],
};

/** Source families to draw from, in priority order. SEC leads because it is tier 1 and dated. */
const SOURCE_PLAN: { sourceId: string; label: string; termIndexes: number[] }[] = [
  { sourceId: 'sec', label: 'SEC Form D', termIndexes: [0, 1, 2] },
  { sourceId: 'funding-news', label: 'funding news RSS', termIndexes: [0] },
  { sourceId: 'yc', label: 'YC directory', termIndexes: [0] },
  { sourceId: 'grants', label: 'SBIR/STTR', termIndexes: [0] },
];

const DAYS = 365;

function query(terms: string[], sources: string[]): DiscoveryQuery {
  return {
    vertical: null, subcategory: null, areasOfInterest: [],
    terms,
    geography: 'United States', states: [],
    stages: ['Pre-seed', 'Seed', 'Series A'],
    sources: sources as DiscoveryQuery['sources'],
    dateFrom: new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10),
    dateTo: new Date().toISOString().slice(0, 10),
    maxResults: 20, maxApiCalls: 20, maxModelCalls: 0, maxEstimatedTokens: 0,
    minConfidence: 0, mode: 'all',
    preview: false, enforceThesisFilter: false, minQualityPriority: null,
    minEvidenceRecencyDays: null, staleAfterDays: 30,
  } as DiscoveryQuery;
}

interface SourceOutcome { sourceId: string; term: string; found: number; mode: string; detail: string }

const sourceOutcomes: SourceOutcome[] = [];

/** Persist a candidate as a company (or match an existing one) and record its deal evidence. */
function persist(cand: RawCandidate, vertical: VerticalId, sourceId: string): string | null {

  const entity = checkEntityType(cand.companyName);
  if (!entity.isOperatingCompany) return null;

  const parsed = importedCompanySchema.safeParse({
    id: `opp-${cand.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
    name: cand.companyName,
    oneLiner: cand.pitch && cand.pitch !== 'Unknown' ? cand.pitch : 'Unknown — not stated by the source',
    vertical,
    subcategory: cand.subcategory && cand.subcategory !== 'Unknown' ? cand.subcategory : 'Unclassified — requires manual review',
    // Never invent a stage. Unknown stays Unknown.
    // RawCandidate omits stage when the source did not state one.
    // Absent becomes the explicit 'Unknown', never a guessed stage.
    stage: cand.stage ?? 'Unknown',
    city: cand.hqCity && cand.hqCity !== 'Unknown' ? cand.hqCity : 'Unknown',
    state: cand.hqState && /^[A-Z]{2}$/.test(cand.hqState) ? cand.hqState : '??',
    foundedYear: cand.foundingYear ?? new Date().getFullYear(),
    teamSize: Math.max(1, cand.founderNames?.length ?? 1),
    website: cand.website && cand.website !== 'Unknown' ? cand.website : undefined,
    raising: cand.publicFunding && cand.publicFunding !== 'Unknown' ? cand.publicFunding : undefined,
    accelerator: cand.accelerator && cand.accelerator !== 'Unknown' ? cand.accelerator : undefined,
    lastFundingDate: cand.fundingDate && /^\d{4}-\d{2}-\d{2}$/.test(cand.fundingDate) ? cand.fundingDate : undefined,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: (cand.founderNames && cand.founderNames.length > 0 ? cand.founderNames : ['Unknown founder'])
      .map((n: string) => ({ name: n, role: 'Unknown', background: 'Unknown — requires manual research' })),
    evidence: cand.evidence.map((e) => ({
      claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' as const,
    })),
    flags: [],
    imported: true as const,
  });
  if (!parsed.success) return null;

  // Reuse an existing record when this is the same company.
  const match = matchCompany({ name: parsed.data.name, domain: parsed.data.website ?? null }, matchRecords());
  const record = match.kind === 'exact' && match.record ? { ...parsed.data, id: match.record.id } : parsed.data;

  if (!DRY_RUN) {
    saveCompany(record, {
      origin: 'extracted', source: `opportunity:${sourceId}`,
      reviewStatus: 'Awaiting Review', discoverySource: sourceId,
      discoveredAt: new Date().toISOString().slice(0, 10),
    });
    saveScore(record.id, scoreCompany(record as unknown as Company), record.evidence.map((e) => e.url));
    for (const ev of candidateToDealEvidence({ ...cand, sourceId })) addDealEvidence(record.id, ev);
    reclassifyCompany(record.id);
  }
  return record.id;
}

const targets = VERTICALS.filter((v) => v.core);

console.log(`Sourcing opportunities for ${targets.length} sectors${DRY_RUN ? ' [DRY RUN]' : ''}`);
console.log(`Leading with SEC Form D (tier 1, dated). Window: last ${DAYS} days.\n`);

for (const v of targets) {
  const terms = SECTOR_TERMS[v.id];
  process.stdout.write(`${v.name}\n`);
  let persisted = 0;

  for (const plan of SOURCE_PLAN) {
    for (const ti of plan.termIndexes) {
      const term = terms[ti];
      if (!term) continue;
      const res = await runSource(plan.sourceId as never, query([term], [plan.sourceId]), 20);
      sourceOutcomes.push({
        sourceId: plan.sourceId, term,
        found: res.candidates?.length ?? 0,
        mode: res.mode,
        detail: res.detail ?? '',
      });
      if (res.mode !== 'live' || !res.candidates) {
        process.stdout.write(`   ${plan.label.padEnd(18)} "${term}": ${res.mode} — ${(res.detail ?? '').slice(0, 90)}\n`);
        continue;
      }
      let kept = 0;
      for (const cand of res.candidates) {
        // Deterministic sector gate BEFORE anything expensive.
        const cls = classifyCandidate({
          companyName: cand.companyName, pitch: cand.pitch,
          subcategory: cand.subcategory,
          evidenceText: cand.evidence.map((e) => e.claim).join(' '),
        });
        if (cls.vertical !== v.id) continue;
        if (persist(cand, v.id, plan.sourceId)) { kept++; persisted++; }
      }
      process.stdout.write(`   ${plan.label.padEnd(18)} "${term}": ${res.candidates.length} returned, ${kept} kept for ${v.id}\n`);
    }
  }
  process.stdout.write(`   → ${persisted} persisted for ${v.name}\n\n`);
}

// ── Report ────────────────────────────────────────────────────────

const shortlists = buildShortlists(targets.map((v) => v.id));
const overall = overallDiversity(shortlists);

console.log('── Shortlists ────────────────────────────────────────────');
for (const s of shortlists) {
  const name = VERTICALS.find((v) => v.id === s.vertical)!.name;
  console.log(`\n${name} — ${s.selected.length}/${PER_SECTOR}${s.shortfall ? `  SHORT BY ${s.shortfall}` : ''}`);
  for (const c of s.selected) {
    const o = c.opportunity;
    console.log(`   ✓ ${c.name}`);
    console.log(`       ${o.classification} · ${o.primarySourceId} (tier ${o.primaryTier}) · ${o.evidencePublishedAt ?? 'undated'}`);
    if (o.amountText) console.log(`       amount: ${o.amountText}`);
    console.log(`       ${o.evidenceUrl}`);
  }
  for (const h of s.heldBack) console.log(`   – ${h.name}: ${h.reason}`);
  if (s.shortageExplanation) console.log(`   ! ${s.shortageExplanation}`);
  for (const w of s.diversity.warnings) console.log(`   ⚠ ${w}`);
}

console.log('\n── Overall diversity ─────────────────────────────────────');
console.log(`Total opportunities : ${overall.total}`);
console.log(`By source           : ${JSON.stringify(overall.bySource)}`);
console.log(`By family           : ${JSON.stringify(overall.byFamily)}`);
console.log(`By tier             : ${JSON.stringify(overall.byTier)}`);
console.log(`YC share            : ${Math.round(overall.ycShare * 100)}%`);
for (const w of overall.warnings) console.log(`⚠ ${w}`);

console.log('\n── Source outcomes ───────────────────────────────────────');
const bySource = new Map<string, { live: number; failed: number; found: number }>();
for (const o of sourceOutcomes) {
  const cur = bySource.get(o.sourceId) ?? { live: 0, failed: 0, found: 0 };
  if (o.mode === 'live') cur.live++; else cur.failed++;
  cur.found += o.found;
  bySource.set(o.sourceId, cur);
}
for (const [src, s] of bySource) {
  console.log(`  ${src.padEnd(14)} live=${s.live} failed=${s.failed} candidates=${s.found} (tier ${tierOf(src)})`);
}
const failures = sourceOutcomes.filter((o) => o.mode !== 'live');
for (const f of failures.slice(0, 6)) console.log(`   ✗ ${f.sourceId} "${f.term}": ${f.detail.slice(0, 130)}`);

console.log(`\nCompanies in database: ${listCompanies().length}`);
