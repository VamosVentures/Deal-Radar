import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies } from '../store/companies';
import { scoreCompany } from '../lib/scoring';
import type { Company } from '../types';
import { ExceptionBadge, IdentityChips, ScoreGauge } from './ui';

/**
 * Vamos Fit ranking with the Phase 4 filter set. Identity filters are
 * VIEW filters only — they never change a score, and they never
 * approve or reject anything. The default view can prioritize
 * verified Latino-founder companies; records with unknown or
 * unverified founders move to a research-queue section below rather
 * than being hidden or deleted.
 */

type VerificationFilter = 'any' | 'latino' | 'female' | 'underrepresented' | 'unknown' | 'requires-review';

const VERTICAL_ROUTE: Record<string, string> = {
  health: '/health', fintech: '/fintech', fow: '/future-of-work',
  sustainability: '/sustainability', aoi: '/areas-of-interest',
};

function verificationBucket(c: Company): 'verified' | 'unknown' | 'requires-review' {
  const anyIdentity = c.founders.some((f) => f.identity);
  if (anyIdentity) return 'verified';
  // Imported/discovered records with placeholder founders need manual research.
  const placeholder = c.founders.some((f) => f.background.toLowerCase().includes('unknown'));
  return placeholder ? 'requires-review' : 'unknown';
}

function matchesVerification(c: Company, f: VerificationFilter): boolean {
  const verified = c.founders.filter((x) => x.identity);
  switch (f) {
    case 'any': return true;
    case 'latino': return verified.some((x) => x.identity!.latinoLed);
    case 'female': return verified.some((x) => x.identity!.femaleLed);
    case 'underrepresented': return verified.some((x) => x.identity!.latinoLed || x.identity!.femaleLed || x.identity!.otherUnderrepresented);
    case 'unknown': return verificationBucket(c) === 'unknown';
    case 'requires-review': return verificationBucket(c) === 'requires-review';
  }
}

const DAY = 86_400_000;

export function Ranking() {
  const { companies, meta } = useCompanies();
  const [show, setShow] = useState<'top10' | 'eightPlus' | 'all'>('top10');
  const [vertical, setVertical] = useState('all');
  const [stage, setStage] = useState('all');
  const [state, setState] = useState('all');
  const [verification, setVerification] = useState<VerificationFilter>('any');
  const [freshness, setFreshness] = useState<'all' | 'fresh30' | 'stale'>('all');
  const [source, setSource] = useState<'all' | 'bundled' | 'imported' | 'discovery'>('all');
  const [exception, setException] = useState<'all' | 'flagged' | 'clean'>('all');
  const [review, setReview] = useState<'all' | 'new' | 'reviewed'>('all');
  const [latinoFirst, setLatinoFirst] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);

  const states = useMemo(() => Array.from(new Set(companies.map((c) => c.state))).sort(), [companies]);

  const filtered = useMemo(() => {
    return companies
      .map((c) => ({ c, fit: scoreCompany(c), m: meta[c.id] }))
      .filter(({ c, fit, m }) => {
        if (vertical !== 'all' && c.vertical !== vertical) return false;
        if (stage !== 'all' && c.stage !== stage) return false;
        if (state !== 'all' && c.state !== state) return false;
        if (!matchesVerification(c, verification)) return false;
        if (exception === 'flagged' && fit.exceptions.length === 0) return false;
        if (exception === 'clean' && fit.exceptions.length > 0) return false;
        const last = c.lastRefreshed ?? m?.lastRefreshed;
        const fresh = last ? Date.now() - new Date(last).getTime() <= 30 * DAY : false;
        if (freshness === 'fresh30' && !fresh) return false;
        if (freshness === 'stale' && fresh) return false;
        const src = m?.discoverySource ? 'discovery' : (c as { imported?: boolean }).imported ? 'imported' : 'bundled';
        if (source !== 'all' && src !== source) return false;
        const isNew = m?.reviewStatus === 'Needs Review';
        if (review === 'new' && !isNew) return false;
        if (review === 'reviewed' && isNew) return false;
        return true;
      })
      .sort((a, b) => b.fit.score - a.fit.score);
  }, [companies, meta, vertical, stage, state, verification, freshness, source, exception, review]);

  // Verified-Latino-first prioritization is a SORT, never a score change.
  const prioritized = useMemo(() => {
    if (!latinoFirst) return { main: filtered, queue: [] as typeof filtered };
    const latino = filtered.filter(({ c }) => matchesVerification(c, 'latino'));
    const otherVerified = filtered.filter(({ c }) => !matchesVerification(c, 'latino') && verificationBucket(c) === 'verified');
    const queue = filtered.filter(({ c }) => verificationBucket(c) !== 'verified');
    return { main: [...latino, ...otherVerified], queue };
  }, [filtered, latinoFirst]);

  const limited = show === 'top10' ? prioritized.main.slice(0, 10)
    : show === 'eightPlus' ? prioritized.main.filter((x) => x.fit.score >= 8)
    : prioritized.main;

  const sel = 'rounded-sm border border-line bg-panel px-2 py-1 text-xs';

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-slate-mid">Vamos Fit ranking</h2>
        <div className="ml-auto flex flex-wrap gap-1">
          {([['top10', 'Top 10'], ['eightPlus', '8.0+ only'], ['all', 'All']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setShow(id)} className={`rounded-sm border px-2 py-1 text-xs ${show === id ? 'border-verde bg-verde-soft font-semibold text-verde' : 'border-line text-slate-mid'}`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <select className={sel} value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Filter by vertical">
          <option value="all">All verticals</option>
          <option value="health">Health & Wellness</option><option value="fintech">FinTech</option>
          <option value="fow">Future of Work</option><option value="sustainability">Sustainability</option>
          <option value="aoi">Areas of Interest</option>
        </select>
        <select className={sel} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="all">All stages</option>
          {['Pre-seed', 'Seed', 'Series A', 'Stealth'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={sel} value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
          <option value="all">All states</option>
          {states.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={sel} value={verification} onChange={(e) => setVerification(e.target.value as VerificationFilter)} aria-label="Filter by founder verification">
          <option value="any">Any founder verification</option>
          <option value="latino">≥1 verified Latino founder</option>
          <option value="female">≥1 verified female founder</option>
          <option value="underrepresented">Any verified underrepresented founder</option>
          <option value="unknown">Verification unknown</option>
          <option value="requires-review">Requires manual review</option>
        </select>
        <select className={sel} value={freshness} onChange={(e) => setFreshness(e.target.value as typeof freshness)} aria-label="Filter by freshness">
          <option value="all">Any freshness</option>
          <option value="fresh30">Refreshed ≤ 30 days</option>
          <option value="stale">Stale / never refreshed</option>
        </select>
        <select className={sel} value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Filter by source">
          <option value="all">Any source</option>
          <option value="bundled">Bundled sample</option>
          <option value="imported">CSV import</option>
          <option value="discovery">Discovery</option>
        </select>
        <select className={sel} value={exception} onChange={(e) => setException(e.target.value as typeof exception)} aria-label="Filter by policy exception">
          <option value="all">Exceptions: any</option>
          <option value="flagged">Policy exception only</option>
          <option value="clean">No exception</option>
        </select>
        <select className={sel} value={review} onChange={(e) => setReview(e.target.value as typeof review)} aria-label="Filter new vs reviewed">
          <option value="all">New + reviewed</option>
          <option value="new">Needs Review only</option>
          <option value="reviewed">Previously reviewed</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-mid">
          <input type="checkbox" checked={latinoFirst} onChange={(e) => setLatinoFirst(e.target.checked)} />
          Verified Latino founders first
        </label>
      </div>

      <p className="mb-2 text-[11px] text-slate-mid">
        Identity filters and prioritization change only what is shown and in what order — they never change a score, and nothing here approves or rejects a company automatically.
      </p>

      <RankTable rows={limited} meta={meta} startRank={1} />

      {latinoFirst && prioritized.queue.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setQueueOpen((o) => !o)} className="text-xs font-semibold text-marigold underline decoration-dotted">
            {queueOpen ? 'Hide' : 'Show'} research queue — {prioritized.queue.length} record(s) with unknown/unverified founders (kept, never deleted)
          </button>
          {queueOpen && <div className="mt-2"><RankTable rows={prioritized.queue} meta={meta} startRank={1} /></div>}
        </div>
      )}
    </section>
  );
}

function RankTable({ rows, meta, startRank }: {
  rows: { c: Company; fit: ReturnType<typeof scoreCompany> }[];
  meta: ReturnType<typeof useCompanies>['meta'];
  startRank: number;
}) {
  if (rows.length === 0) return <p className="text-sm text-slate-mid">No companies match these filters.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-panel">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-slate-mid">
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Score</th>
            <th className="px-3 py-2">Company</th>
            <th className="px-3 py-2">Vertical / stage</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Founders</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, fit }, i) => {
            const m = meta[c.id];
            return (
              <tr key={c.id} className="border-b border-line align-top">
                <td className="px-3 py-2.5 font-mono text-xs text-slate-mid">{startRank + i}</td>
                <td className="px-3 py-2.5"><ScoreGauge score={fit.score} /></td>
                <td className="px-3 py-2.5">
                  <Link to={`${VERTICAL_ROUTE[c.vertical]}?c=${c.id}`} className="font-semibold hover:underline">{c.name}</Link>
                  <div className="max-w-xs text-xs text-slate-mid">{c.oneLiner}</div>
                </td>
                <td className="px-3 py-2.5 text-xs">{c.vertical} · {c.stage}</td>
                <td className="px-3 py-2.5 text-xs">{c.state}</td>
                <td className="px-3 py-2.5"><IdentityChips founders={c.founders} /></td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} compact />)}
                    {m?.reviewStatus === 'Needs Review' && <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-marigold">Needs Review</span>}
                    {m?.discoverySource && <span className="rounded-sm bg-paper px-1.5 py-0.5 font-mono text-[10px] text-slate-mid">via {m.discoverySource}</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
