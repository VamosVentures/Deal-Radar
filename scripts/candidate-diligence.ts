/**
 * Controlled combined diligence for named candidates.
 *
 *   DATABASE_FILE=/tmp/copy.db npm run diligence -- Manifold Grade Unifold "Scheduling Wizard"
 *
 * PREVIEW ONLY. Discovery runs with `preview: true` (writes no candidate,
 * run, company, score or id counter), and the enrichment + founder
 * research stages are pure reads over public pages. Nothing is added to
 * the pipeline, no CRM stage moves, nothing syncs, nobody is contacted,
 * and no traction is invented — traction is an analyst judgement and
 * this script never records one.
 *
 * For each candidate it reports the BEFORE state (what discovery alone
 * knows), then runs company evidence enrichment and the existing founder
 * research pipeline, then re-scores under the unchanged v4.1 rubric and
 * reports the AFTER state.
 */
import { runDiscovery, resolveVertical, candidateToImportedCompany } from '../server/services/discovery';
import { enrichCandidateEvidence, applyEnrichment } from '../server/sourcing/evidenceEnrichment';
import { researchFoundersForRecord } from '../server/services/enrichment';
import { isYcProfileUrl, parseYcProfile } from '../server/enrichment/ycProfile';
import { politeFetch } from '../server/sourcing/politeness';
import { assessQuality } from '../server/sourcing/qualitySignals';
import { assessPromising } from '../src/lib/promisingQueue';
import { scoreCompany, NON_PROVISIONAL_POLICY } from '../src/lib/scoring';
import { RequestBudget } from '../server/sourcing/politeness';
import { HOT_THRESHOLD } from '../shared/scoringThresholds';
import { CORE_VERTICAL_IDS, verticalById } from '../src/data/taxonomy';
import type { DiscoveryCandidate } from '../shared/discovery';
import type { Company, VerticalId } from '../src/types';

const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const NOW = new Date();
/**
 * PER-COMPANY budgets, not one shared pool.
 *
 * A single shared RequestBudget starved the companies later in the list:
 * the first two consumed it and the rest reported "0/9 source families
 * answered / manual-review-required", which reads as a finding about the
 * COMPANY when it was really a finding about our own budget. Each
 * candidate now gets its own allowance for each stage, so a verdict
 * always means what it says.
 */
const ENRICH_PAGES_PER_COMPANY = 6;
const FOUNDER_PAGES_PER_COMPANY = 8;
const BATCH_WINDOW_DAYS = 550;

interface Snapshot {
  score: number | null;
  provisional: boolean | null;
  completeness: number | null;
  missingCritical: string[];
  founderEvidence: number;
  tractionEvidence: number;
  independentSources: number;
  components: { key: string; label: string; points: number; max: number; assessable: boolean }[];
}

function snapshot(
  c: DiscoveryCandidate,
  founderBios: { fullName: string; role: string | null; bio: string | null }[] = [],
): Snapshot {
  const resolved = resolveVertical(c);
  const empty: Snapshot = {
    score: null, provisional: null, completeness: null, missingCritical: [],
    founderEvidence: c.founderNames.length,
    tractionEvidence: c.tractionSignals.length,
    independentSources: c.independentSources,
    components: [],
  };
  if (!resolved.vertical) return empty;
  const company = candidateToImportedCompany(c, resolved.vertical);
  if (!company.success) return empty;
  // Researched founders replace the placeholder row. NAME AND RECORDED
  // BACKGROUND ONLY — nothing about a person is derived from their name.
  const withFounders = founderBios.length > 0
    ? {
      ...company.value,
      founders: founderBios.map((f) => ({
        name: f.fullName,
        role: f.role ?? 'Unknown',
        background: f.bio ?? 'Unknown — requires manual research',
      })),
    }
    : company.value;
  const fit = scoreCompany(withFounders as unknown as Company, NOW);
  const byKey = new Map(fit.components.map((x) => [x.key, x]));
  return {
    ...empty,
    score: fit.score,
    provisional: fit.provisional,
    completeness: fit.completeness,
    missingCritical: NON_PROVISIONAL_POLICY.requiredComponents.filter((k) => !byKey.get(k)?.assessable),
    components: fit.components.map((x) => ({ key: x.key, label: x.label, points: x.points, max: x.max, assessable: x.assessable })),
  };
}

/** Find the named candidates by sweeping every vertical in preview mode. */
async function discover(names: string[]): Promise<Map<string, DiscoveryCandidate>> {
  const found = new Map<string, DiscoveryCandidate>();
  const dateFrom = new Date(Date.now() - BATCH_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const v of CORE_VERTICAL_IDS as VerticalId[]) {
    if (found.size === names.length) break;
    const run = await runDiscovery({
      vertical: v, terms: [], sources: ['yc', 'funding-news'],
      maxResults: 20, maxApiCalls: 4, geography: 'United States', mode: 'all',
      preview: true, dateFrom,
    }, 'diligence', 'manual');
    for (const c of run.previewCandidates ?? []) {
      const hit = names.find((n) => n.toLowerCase() === c.companyName.toLowerCase());
      if (hit && !found.has(hit)) found.set(hit, c);
    }
  }
  return found;
}

function line(label: string, value: string) {
  console.log(`   ${label.padEnd(26, '.')} ${value}`);
}

async function main(): Promise<void> {
  console.log('Combined company + founder diligence — PREVIEW ONLY, nothing persisted.');
  console.log(`Targets: ${TARGETS.join(', ')}`);
  console.log(`Rubric: unchanged v4.1, High-Fit threshold ${HOT_THRESHOLD}.0. No traction is recorded by this script.\n`);

  const found = await discover(TARGETS);
  for (const name of TARGETS) {
    if (!found.has(name)) console.log(`  ! ${name}: not returned by any source in this run.`);
  }

  for (const [name, candidate] of found) {
    console.log(`\n${'═'.repeat(74)}\n${name}\n${'═'.repeat(74)}`);
    const before = snapshot(candidate);

    // ── Stage 3a: company evidence enrichment ────────────────────
    const evidence = await enrichCandidateEvidence(candidate, {
      maxPages: ENRICH_PAGES_PER_COMPANY,
      budget: new RequestBudget(ENRICH_PAGES_PER_COMPANY),
      now: NOW,
    });
    let enriched = applyEnrichment(candidate, evidence);

    // ── Stage 3b: founder research, via the EXISTING pipeline ────
    const founders = await researchFoundersForRecord({
      id: enriched.id,
      name: enriched.companyName,
      website: enriched.website !== 'Unknown' ? enriched.website : null,
      accelerator: enriched.accelerator !== 'Unknown' ? enriched.accelerator : null,
      city: enriched.hqCity !== 'Unknown' ? enriched.hqCity : null,
      state: enriched.hqState !== 'Unknown' ? enriched.hqState : null,
      evidence: enriched.evidence.map((e) => ({
        claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record',
      })),
      dealEvidence: [],
    }, { budget: new RequestBudget(FOUNDER_PAGES_PER_COMPANY), at: NOW.toISOString() });

    // Fold researched founders on. NAME AND RECORDED BACKGROUND ONLY —
    // nothing about a person is derived from their name.
    if (founders.candidates.length > 0 && enriched.founderNames.length === 0) {
      const unique = [...new Map(founders.candidates.map((f) => [f.personKey, f])).values()];
      enriched = {
        ...enriched,
        founderNames: unique.map((f) => f.fullName),
        founderCount: unique.length,
        evidence: [
          ...enriched.evidence,
          ...unique
            .filter((f) => !enriched.evidence.some((e) => e.url === f.sourceUrl))
            .map((f) => ({
              claim: `founder: ${f.fullName}${f.title ? ` — ${f.title}` : ''}. ${f.supportingText}`,
              source: f.sourceType, url: f.sourceUrl,
              dateAccessed: NOW.toISOString().slice(0, 10),
              publishedAt: f.publishedAt,
              verificationStatus: 'Not verified' as const,
              confidence: f.confidence, notes: `Source family: ${f.sourceFamily}.`,
              assertionType: 'fact' as const,
            })),
        ],
      };
    }

    /**
     * The YC profile, parsed structurally, is where the founders and the
     * company-authored traction claims actually live. Fetched once here
     * for the report; politeFetch caches, so the founder pass above
     * already warmed it.
     */
    const ycUrl = enriched.evidence.map((e) => e.url).find(isYcProfileUrl);
    let ycProfile: ReturnType<typeof parseYcProfile> = null;
    if (ycUrl) {
      const res = await politeFetch(ycUrl, {
        budget: new RequestBudget(2),
        headers: { 'user-agent': 'VamosDealRadar/1.0 (deal sourcing research; contact: matthew@vamosventures.com)' },
      });
      if (res.ok) ycProfile = parseYcProfile(res.body, ycUrl);
    }

    // Founder biographies from the YC profile feed the FOUNDER component.
    if (ycProfile && ycProfile.founders.length > 0) {
      enriched = {
        ...enriched,
        founderNames: ycProfile.founders.map((f) => f.fullName),
        founderCount: ycProfile.founders.length,
      };
    }

    const after = snapshot(enriched, ycProfile?.founders ?? []);
    /**
     * Triage priority is RECOMPUTED here, from the post-enrichment
     * snapshot — founder biographies and the company-claimed traction
     * claims the YC profile produced. Computing it once at discovery
     * time (which is all that used to happen) meant a stale value
     * decided queue membership: Grade sat at LOW while carrying two
     * cited founder backgrounds and a published payment-volume claim,
     * neither of which existed when the number was first calculated.
     */
    const quality = assessQuality(enriched, NOW, {
      founderBios: (ycProfile?.founders ?? [])
        .filter((f) => f.bio)
        .map((f) => ({ text: `${f.fullName} — ${f.role ?? 'founder'}. ${f.bio}`, sourceUrl: ycProfile!.canonicalUrl })),
      companyClaimed: (ycProfile?.tractionClaims ?? [])
        .filter((t) => t.aboutThisCompany)
        .map((t) => ({ text: t.quote, sourceUrl: ycProfile!.canonicalUrl })),
    });

    // ── Report ───────────────────────────────────────────────────
    line('Website', enriched.website);
    line('Vertical', resolveVertical(enriched).vertical ? verticalById(resolveVertical(enriched).vertical!).name : 'unclassifiable');
    line('HQ', `${enriched.hqCity}${enriched.hqState !== 'Unknown' ? `, ${enriched.hqState}` : ' (state not established — geography does not score)'}`);
    line('Accelerator', enriched.accelerator);
    line('Stage', enriched.stage);
    line('Founders', enriched.founderNames.length > 0 ? enriched.founderNames.join(', ') : 'none established');
    line('Founder verdict', `${founders.verdict.status} — ${founders.familiesAnswered}/9 source families answered`);
    if (ycProfile) {
      line('YC profile', `${ycProfile.canonicalUrl} · batch ${ycProfile.batch} · ${ycProfile.status} · team ${ycProfile.teamSize} · founded ${ycProfile.foundedYear}`);
      console.log(`   Founder backgrounds (company-claimed, via YC):`);
      for (const f of ycProfile.founders) {
        console.log(`     • ${f.fullName} — ${f.role ?? 'founder'}`);
        console.log(`       "${(f.bio ?? '').slice(0, 150)}"`);
      }
      const aboutCo = ycProfile.tractionClaims.filter((c) => c.aboutThisCompany);
      const aboutPrior = ycProfile.tractionClaims.filter((c) => !c.aboutThisCompany);
      console.log(`   Traction claims (PENDING analyst review, company-claimed): ${aboutCo.length}`);
      for (const t of aboutCo.slice(0, 5)) console.log(`     [${t.section}] "${t.quote.slice(0, 120)}"`);
      if (aboutPrior.length > 0) {
        console.log(`   Founder-market-fit claims (PRIOR companies, NOT this company's traction): ${aboutPrior.length}`);
        for (const t of aboutPrior.slice(0, 3)) console.log(`     [${t.section}] "${t.quote.slice(0, 120)}"`);
      }
      line('Stage evidence', `batch ${ycProfile.batch}, status ${ycProfile.status} — a cited FACT, not a financing round. Stage stays Unknown pending analyst confirmation.`);
    }

    console.log('\n   BEFORE (discovery only)          AFTER (enrichment + founder research)');
    const row = (l: string, a: string, b: string) => console.log(`   ${l.padEnd(26)} ${a.padEnd(14)} ${b}`);
    row('founder evidence', String(before.founderEvidence), String(after.founderEvidence));
    row('traction evidence', String(before.tractionEvidence), String(after.tractionEvidence));
    row('independent sources', String(before.independentSources), String(after.independentSources));
    row('evidence completeness', `${Math.round((before.completeness ?? 0) * 100)}%`, `${Math.round((after.completeness ?? 0) * 100)}%`);
    row('missing critical', before.missingCritical.join(',') || 'none', after.missingCritical.join(',') || 'none');
    row('Vamos score', before.score?.toFixed(1) ?? 'n/a', after.score?.toFixed(1) ?? 'n/a');
    row('provisional', String(before.provisional), String(after.provisional));

    if (after.components.length > 0) {
      console.log('\n   Component breakdown (after):');
      for (const c of after.components) {
        console.log(`     ${c.assessable ? ' ' : '~'} ${c.label.padEnd(38)} ${String(c.points).padStart(2)}/${c.max}${c.assessable ? '' : '  (not assessable)'}`);
      }
    }

    // Promising-queue eligibility, computed the same way the UI does.
    const resolvedV = resolveVertical(enriched);
    if (resolvedV.vertical) {
      const asCompany = candidateToImportedCompany(enriched, resolvedV.vertical);
      if (asCompany.success) {
        const scored = ycProfile && ycProfile.founders.length > 0
          ? {
            ...asCompany.value,
            founders: ycProfile.founders.map((f) => ({
              name: f.fullName, role: f.role ?? 'Unknown',
              background: f.bio ?? 'Unknown — requires manual research',
            })),
          }
          : asCompany.value;
        const fit = scoreCompany(scored as unknown as Company, NOW);
        const promising = assessPromising({
          company: scored as unknown as Company,
          fit,
          qualityBand: quality.band,
          qualityPriority: quality.priority,
          qualitySignals: quality.signals,
          thesisEligible: enriched.thesisEligible,
          confirmedDuplicate: enriched.duplicateStatus === 'exact',
        });
        console.log(`\n   Quality priority ......... ${quality.priority}/100 (${quality.band}) — RECOMPUTED post-enrichment`);
        for (const sig of quality.signals.filter((x) => x.direction === 'positive')) {
          console.log(`     +${String(sig.points).padStart(2)} ${sig.label}${sig.weight < 1 ? ` (${sig.fullPoints} × ${sig.weight} company-claimed)` : ''} — "${sig.evidence.slice(0, 70)}"`);
        }
        for (const sig of quality.signals.filter((x) => x.direction === 'negative')) {
          console.log(`     ${String(sig.points).padStart(3)} ${sig.label}`);
        }
        console.log(`   Needs Diligence .......... ${promising.needsDiligence ? 'YES' : 'no'}`);
        console.log(`   Promising ................ ${promising.eligible ? 'YES' : 'no'}${promising.eligible ? '' : ` — ${promising.exclusions.join(' ')}`}`);
        if (promising.substantiveSignals.length > 0) {
          console.log(`     substantive: ${promising.substantiveSignals.join(' | ')}`);
        }
        if (promising.eligible) {
          console.log(`     reasons: ${promising.reasons.join(' ')}`);
          console.log(`     next action: ${promising.nextAction}`);
          console.log(`     primary risk: ${promising.primaryRisk}`);
        }
        const highFit = !fit.provisional && fit.score >= HOT_THRESHOLD;
        console.log(`   High-Fit eligible ........ ${highFit ? 'YES' : `no (${fit.provisional ? 'provisional' : `score ${fit.score.toFixed(1)} < ${HOT_THRESHOLD}`})`}`);
      }
    }

    console.log(`\n   Cited facts (${evidence.facts.length}):`);
    for (const f of evidence.facts.slice(0, 8)) {
      console.log(`     [${f.assertionType}/${f.sourceKind}] ${f.field}: "${f.quote.slice(0, 80)}" — ${f.sourceUrl}`);
    }
    /**
     * "Not publicly available" must be computed from EVERYTHING we
     * gathered, not from the company-site pass alone. Reporting
     * "founders: not publicly available" on the same screen that lists
     * three founders off the YC profile is exactly the contradiction
     * this pass exists to remove.
     */
    const resolvedByYc = new Set<string>();
    if (ycProfile) {
      if (ycProfile.founders.length > 0) resolvedByYc.add('founders');
      if (ycProfile.location) resolvedByYc.add('hq');
      if (ycProfile.batch) { resolvedByYc.add('accelerator'); resolvedByYc.add('validation'); }
      if (ycProfile.description) resolvedByYc.add('product');
      if (ycProfile.tractionClaims.some((t) => t.aboutThisCompany)) resolvedByYc.add('customers');
      if (ycProfile.launchPost) resolvedByYc.add('activity');
    }
    const stillUnresolved = evidence.unresolved.filter((f) => !resolvedByYc.has(f));
    if (stillUnresolved.length > 0) {
      console.log(`   No public source states .. ${stillUnresolved.join(', ')}`);
    }
    if (resolvedByYc.size > 0) {
      console.log(`   Resolved via YC profile .. ${[...resolvedByYc].join(', ')}`);
    }
    console.log(`   Remaining diligence ...... ${after.missingCritical.length > 0
      ? `${after.missingCritical.join(', ')} — traction needs an analyst review; the rest need a source that states it.`
      : 'none blocking'}`);
  }

  console.log(`\n${'═'.repeat(74)}\nNothing was persisted. No traction was recorded — that is an analyst judgement.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
