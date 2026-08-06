import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies } from '../store/companies';
import { scoreCompany } from '../lib/scoring';
import { VERTICALS } from '../data/taxonomy';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import { ExceptionBadge, IdentityChips, ScoreGauge } from './ui';

/**
 * Vamos Fit ranking — strongest current opportunities first, with the
 * primary filters only (vertical, stage, state) and free search.
 */
export function Ranking() {
  const { companies, meta, quarantine } = useCompanies();
  const [show, setShow] = useState<'top10' | 'highFit' | 'all'>('top10');
  const [vertical, setVertical] = useState('all');
  const [stage, setStage] = useState('all');
  const [state, setState] = useState('all');
  const [q, setQ] = useState('');
  // Disqualified records are excluded by DEFAULT and can be shown
  // deliberately — the same rule the company queue already applies.
  const [showDisqualified, setShowDisqualified] = useState(false);

  const states = useMemo(() => Array.from(new Set(companies.map((c) => c.state))).sort(), [companies]);

  const quarantinedCount = useMemo(
    () => companies.filter((c) => quarantine[c.id]).length,
    [companies, quarantine],
  );

  const filtered = useMemo(() => {
    return companies
      .map((c) => ({ c, fit: scoreCompany(c), m: meta[c.id] }))
      .filter(({ c }) => {
        // A quarantined record is not a prospect. This ranking was showing
        // them unmarked and sorted by fit score alongside real leads, so a
        // publicly traded company (Adagio Medical Holdings, ticker ADGM)
        // sat at rank 4 and a numbered solar project vehicle (Trinary
        // Solar Group VIII LLC) at rank 7 — both already disqualified by
        // stored verdicts, both reading as top prospects.
        if (!showDisqualified && quarantine[c.id]) return false;
        if (vertical !== 'all' && c.vertical !== vertical) return false;
        if (stage !== 'all' && c.stage !== stage) return false;
        if (state !== 'all' && c.state !== state) return false;
        const hay = [
          c.name, c.oneLiner, c.subcategory, c.city, c.state,
          c.website ?? '', c.founders.map((f) => f.name).join(' '),
        ].join(' ').toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      })
      // Strongest first — but an assessed company always outranks a
      // provisional one, whatever the raw numbers say. A provisional score
      // is derived only from our own sourcing quality, so letting it top
      // the list would put "we sourced this well" above "this fits".
      .sort((a, b) =>
        Number(a.fit.provisional) - Number(b.fit.provisional)
        || b.fit.score - a.fit.score);
  }, [companies, meta, vertical, stage, state, q, quarantine, showDisqualified]);

  /**
   * "High-Fit" here must mean what it means on the KPI cards.
   *
   * This filter was a bare `>= 8` with no provisional check, while
   * server/services/executiveKpis.ts requires `!provisional && score >=
   * HOT_THRESHOLD`. Both render on the Overview, so a provisional 8.2
   * appeared in this list and was simultaneously excluded from the
   * High-Fit card — two numbers disagreeing on one screen, which reads as
   * a bug in the data rather than in two definitions.
   *
   * shared/scoringThresholds.ts exists because the threshold was
   * "previously duplicated as a bare 8/6.5 literal in four separate
   * files"; this was the literal that survived the consolidation.
   */
  const limited =
    show === 'top10' ? filtered.slice(0, 10)
    : show === 'highFit' ? filtered.filter((x) => !x.fit.provisional && x.fit.score >= HOT_THRESHOLD)
    : filtered;

  const sel = 'rounded-[2px] border border-line bg-panel px-2 py-1 text-xs transition-colors focus:border-marigold';

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-slate-mid">Vamos Fit ranking</h2>
        <div className="ml-auto flex flex-wrap gap-1 border border-line bg-panel p-0.5">
          {([['top10', 'Top 10'], ['highFit', `High-Fit (assessed, ${HOT_THRESHOLD.toFixed(1)}+)`], ['all', 'All']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setShow(id)} className={`rounded-[1px] px-2 py-1 text-xs transition-colors ${show === id ? 'bg-verde-soft font-semibold text-verde' : 'text-slate-mid hover:text-ink'}`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, founder, website, keyword…"
          className={`${sel} w-60`}
          aria-label="Search ranking"
        />
        <select className={sel} value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Filter by vertical">
          <option value="all">All verticals</option>
          {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select className={sel} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="all">All stages</option>
          {['Pre-seed', 'Seed', 'Series A', 'Stealth'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={sel} value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
          <option value="all">All states</option>
          {states.map((s) => <option key={s}>{s}</option>)}
        </select>
        {quarantinedCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-mid" title="Publicly traded companies, funds, SPVs, and records nothing corroborates. Excluded from the ranking because they are not prospects; their evidence is retained.">
            <input
              type="checkbox"
              checked={showDisqualified}
              onChange={(e) => setShowDisqualified(e.target.checked)}
            />
            Show disqualified ({quarantinedCount})
          </label>
        )}
      </div>

      {limited.length === 0 ? (
        <p className="border border-line bg-panel px-4 py-6 text-sm text-slate-mid">
          No companies match. Clear a filter, run Deal Discovery, or import a CSV under Settings.
        </p>
      ) : (
        <div className="overflow-x-auto border border-line bg-panel">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-ink text-white">
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">#</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Score</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Company</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Vertical / stage</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">State</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Founders</th>
                <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Status</th>
              </tr>
            </thead>
            <tbody>
              {limited.map(({ c, fit, m }, i) => (
                <tr key={c.id} className="border-b border-line align-top transition-colors hover:bg-paper/60">
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-slate-mid">{i + 1}</td>
                  <td className="px-3 py-2.5"><ScoreGauge score={fit.score} /></td>
                  <td className="px-3 py-2.5">
                    <Link to={`/companies?c=${c.id}`} className="font-semibold text-ink hover:underline">{c.name}</Link>
                    <div className="max-w-xs text-xs text-slate-mid">{c.oneLiner}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">{c.vertical} · {c.stage}</td>
                  <td className="px-3 py-2.5 text-xs">{c.state}</td>
                  <td className="px-3 py-2.5"><IdentityChips founders={c.founders} /></td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {quarantine[c.id] && (
                        <span
                          className="rounded-[2px] bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta"
                          title={quarantine[c.id].reason}
                        >
                          Disqualified
                        </span>
                      )}
                      {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} compact />)}
                      {(m?.reviewStatus === 'New' || m?.reviewStatus === 'Awaiting Review') && (
                        <span className="rounded-[2px] bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-marigold">{m.reviewStatus}</span>
                      )}
                      {m?.stale && <span className="rounded-[2px] bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta">Stale</span>}
                      {m?.discoverySource && <span className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10px] text-slate-mid">via {m.discoverySource}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
