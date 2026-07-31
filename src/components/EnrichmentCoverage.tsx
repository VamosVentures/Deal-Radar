import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies } from '../store/companies';
import type { Company } from '../types';
import type { CompanyEnrichment } from '../../shared/enrichment';

/**
 * Portfolio-wide research coverage: what is known, what is genuinely not
 * public, and what is simply unsearched.
 *
 * The per-company panels answer "what do we know about THIS company".
 * Nobody could answer "where is the pipeline weakest, and what would fix
 * the most records at once" without opening 209 of them. This does.
 *
 * The distinction the whole panel turns on is between a gap in the WORLD
 * and a gap in OUR COVERAGE. "No founder is publicly attributable" is a
 * finding a reviewer can accept and move on from. "We never searched the
 * company's own website because no website is on record" is a task. They
 * look identical in a per-row view and are completely different work, so
 * they are counted separately here and the second one is the actionable
 * number.
 */

interface Bucket {
  label: string;
  /** Companies in this state. */
  n: number;
  /** True when this is OUR gap to close rather than an absence in the world. */
  actionable: boolean;
  detail: string;
  /** Where to go to act on it. */
  href?: string;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

function Row({ b, total }: { b: Bucket; total: number }) {
  return (
    <li className="flex items-baseline gap-2 py-1">
      <span className="w-10 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-ink">{b.n}</span>
      <span className="w-10 shrink-0 font-mono text-[10px] tabular-nums text-slate-mid">{pct(b.n, total)}</span>
      <span className="min-w-0 flex-1">
        <span className={b.actionable ? 'text-sm font-medium text-ink' : 'text-sm text-slate-mid'}>
          {b.href ? <Link to={b.href} className="underline decoration-dotted underline-offset-2">{b.label}</Link> : b.label}
        </span>
        <span className="block text-[11px] leading-snug text-slate-mid">{b.detail}</span>
      </span>
    </li>
  );
}

export function EnrichmentCoverage() {
  const { companies, enrichment, quarantine } = useCompanies();

  const stats = useMemo(() => {
    // Quarantined records are already decided — counting them as coverage
    // gaps would inflate every number with work nobody should do.
    const live = companies.filter((c) => !quarantine[c.id]);
    const total = live.length;

    const get = (c: Company): CompanyEnrichment | undefined => enrichment[c.id];

    const notResearched = live.filter((c) => !get(c)).length;
    const founderVerified = live.filter((c) => get(c)?.founder.state === 'confirmed').length;
    const founderCandidate = live.filter((c) => get(c)?.founder.state === 'candidate').length;
    const founderConflict = live.filter((c) => get(c)?.founder.state === 'conflict').length;
    const founderExhausted = live.filter((c) => get(c)?.founder.state === 'research-exhausted').length;
    const founderManual = live.filter((c) => get(c)?.founder.state === 'manual-review' && get(c)).length;

    const sectorConfirmed = live.filter((c) => get(c)?.vertical.state === 'confirmed').length;
    const sectorInferred = live.filter((c) => get(c)?.vertical.inferred).length;
    const sectorNone = live.filter((c) => get(c)?.vertical.value?.countsTowardRanking === false).length;

    const stageExplicit = live.filter((c) => get(c)?.stage.state === 'confirmed').length;
    const stageInferred = live.filter((c) => get(c)?.stage.inferred).length;

    // The coverage gaps — ours to close, not the world's.
    const noWebsite = live.filter((c) => !c.website).length;
    const noLocation = live.filter((c) => !c.state || c.state === '??' || c.state === 'Unknown').length;
    const noFunding = live.filter((c) => !c.raising && !c.lastFundingDate).length;
    const noTraction = live.filter((c) => c.traction.level === 0).length;

    return {
      total, notResearched,
      founderVerified, founderCandidate, founderConflict, founderExhausted, founderManual,
      sectorConfirmed, sectorInferred, sectorNone,
      stageExplicit, stageInferred,
      noWebsite, noLocation, noFunding, noTraction,
    };
  }, [companies, enrichment, quarantine]);

  if (stats.total === 0) return null;

  const founders: Bucket[] = [
    {
      label: 'Verified founder', n: stats.founderVerified, actionable: false,
      detail: 'A named person with an attributable source. Usable for outreach and CRM.',
    },
    {
      label: 'Conflicting evidence', n: stats.founderConflict, actionable: true,
      href: '/stealth', detail: 'Two sources name different people. A reviewer decides; the radar shows both.',
    },
    {
      label: 'Unconfirmed candidate', n: stats.founderCandidate, actionable: true,
      href: '/stealth', detail: 'Someone plausible was found and is not asserted. Confirm or reject on the radar.',
    },
    {
      label: 'Research incomplete', n: stats.founderManual, actionable: true,
      href: '/stealth', detail: 'A source did not respond, or the company has never been researched. Re-runnable.',
    },
    {
      label: 'Not publicly attributable', n: stats.founderExhausted, actionable: false,
      detail: 'Every reachable source was searched and none names a founder. A finding, not a backlog item.',
    },
  ];

  const gaps: Bucket[] = [
    {
      label: 'No website on record', n: stats.noWebsite, actionable: true,
      detail: 'The strongest founder source — the company’s own About and Team pages — cannot be searched without one.',
    },
    {
      label: 'No location on record', n: stats.noLocation, actionable: true,
      detail: 'Geography is a scored component, so this suppresses part of the thesis score.',
    },
    {
      label: 'No funding evidence', n: stats.noFunding, actionable: true,
      detail: 'No amount or date on record from any source.',
    },
    {
      label: 'No traction rating', n: stats.noTraction, actionable: true,
      detail: 'A 0–10 analyst judgement with a written justification. No public source states it — a reviewer enters it.',
    },
  ];

  return (
    <section className="border border-line bg-panel p-4" data-testid="enrichment-coverage">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-ink">Research coverage</h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
          {stats.total} live companies
        </span>
      </div>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-mid">
        What the pipeline has established, and where it is blocked. A gap in the world —
        “no founder is publicly attributable” — is a finding to accept. A gap in our coverage —
        “no website on record, so we never searched their own site” — is a task. They are
        counted separately, because they are completely different work.
      </p>

      {stats.notResearched > 0 && (
        <p className="mb-3 border border-marigold/40 bg-marigold/5 px-3 py-2 text-xs text-ink">
          <span className="font-semibold">{stats.notResearched}</span> companies have never been researched.
          Run <code className="font-mono">npm run db:enrich -- --apply</code> to search every source family for them.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <h3 className="mb-1 font-mono text-[10px] uppercase tracking-widest text-slate-mid">Founder</h3>
          <ul className="divide-y divide-line/60">
            {founders.map((b) => <Row key={b.label} b={b} total={stats.total} />)}
          </ul>
        </div>

        <div>
          <h3 className="mb-1 font-mono text-[10px] uppercase tracking-widest text-slate-mid">Sector &amp; stage</h3>
          <ul className="divide-y divide-line/60">
            <Row total={stats.total} b={{
              label: 'Sector stated by the company', n: stats.sectorConfirmed, actionable: false,
              detail: 'Classified from the company’s own description of what it does and who pays.',
            }} />
            <Row total={stats.total} b={{
              label: 'Sector inferred', n: stats.sectorInferred, actionable: false,
              detail: 'Bounded from third-party text or an accelerator’s own category. Labelled as inferred on every row.',
            }} />
            <Row total={stats.total} b={{
              label: 'Not classifiable', n: stats.sectorNone, actionable: false,
              detail: 'Identity as an operating company is unresolved. Excluded from sector rankings.',
            }} />
            <Row total={stats.total} b={{
              label: 'Stage named by a source', n: stats.stageExplicit, actionable: false,
              detail: 'A round an announcement, investor, or accelerator actually names.',
            }} />
            <Row total={stats.total} b={{
              label: 'Stage inferred', n: stats.stageInferred, actionable: false,
              detail: 'Early-stage with the round undisclosed. An SEC filing alone never names a round.',
            }} />
          </ul>
        </div>

        <div>
          <h3 className="mb-1 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            Coverage gaps — ours to close
          </h3>
          <ul className="divide-y divide-line/60">
            {gaps.map((b) => <Row key={b.label} b={b} total={stats.total} />)}
          </ul>
        </div>
      </div>
    </section>
  );
}
