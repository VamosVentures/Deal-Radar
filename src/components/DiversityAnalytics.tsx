import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { DiversityAnalytics as Analytics } from '../lib/api';

/**
 * Source-concentration analytics.
 *
 * This panel exists because "35 companies across 7 sectors" sounded
 * healthy while being 100% one source, and later 82% one source. The
 * numbers that reveal that are concentration and corroboration, so those
 * are the ones shown first — not the total, which is the least
 * informative figure available.
 *
 * Every value is computed from persisted evidence and stored
 * qualification verdicts. Nothing is modelled or estimated.
 */
export function DiversityAnalyticsPanel() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.admin.diversityAnalytics()
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  if (err) {
    return (
      <section className="mt-8">
        <h2 className="mb-2 font-display text-base font-semibold text-ink">Source diversity</h2>
        <p className="text-xs text-alerta">{err}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="mt-8">
        <h2 className="mb-2 font-display text-base font-semibold text-ink">Source diversity</h2>
        <p className="text-xs text-slate-mid">Computing…</p>
      </section>
    );
  }

  const cell = 'px-2 py-1.5';
  const th = 'px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-slate-mid';

  return (
    <section className="mt-8">
      <h2 className="mb-1 font-display text-base font-semibold text-ink">Source diversity</h2>
      <p className="mb-3 max-w-3xl text-xs text-slate-mid">
        Computed from persisted evidence and stored qualification verdicts — never estimated. Concentration
        and corroboration come first because a large shortlist drawn from one source is not a diversified
        pipeline.
      </p>

      {data.warnings.length > 0 && (
        <div className="mb-3 space-y-1 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft px-3 py-2 text-xs text-marigold">
          {data.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}

      <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Live opportunities" value={data.totalOpportunities} hint="Recent financing, fundraising signal, or verified opportunity — and not quarantined." />
        <Stat label="Company leads" value={data.companyLeads} hint="Companies that exist without current financing or fundraising evidence." />
        <Stat label="≥2 sources" value={data.multiSourceOpportunities} hint="Opportunities corroborated by two or more independent source families." tone={data.multiSourceOpportunities > 0 ? 'good' : undefined} />
        <Stat label="1 source only" value={data.singleSourceOpportunities} hint="Rests on a single source family. A lone filing is not corroboration." tone={data.singleSourceOpportunities > 0 ? 'warn' : undefined} />
        <Stat label="Public excluded" value={data.publicCompaniesExcluded} hint="Issuers with an exchange ticker or periodic reports. Not venture deals." />
        <Stat label="Funds/SPVs excluded" value={data.fundsOrSpvsExcluded} hint="Pooled vehicles and project entities." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Opportunities by primary source</h3>
          {Object.keys(data.byPrimarySource).length === 0 ? (
            <p className="text-xs text-slate-mid">No live opportunities yet, so there is no concentration to report.</p>
          ) : (
            <table className="w-full border border-line text-xs">
              <thead className="bg-paper"><tr><th className={th}>Source</th><th className={th}>Count</th><th className={th}>Share</th></tr></thead>
              <tbody>
                {Object.entries(data.byPrimarySource).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                  <tr key={src} className="border-t border-line">
                    <td className={cell}>{src}</td>
                    <td className={`${cell} tabular-nums`}>{n}</td>
                    <td className={`${cell} tabular-nums ${(data.sharePct[src] ?? 0) > 40 ? 'font-semibold text-marigold' : ''}`}>
                      {data.sharePct[src] ?? 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="mb-1 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">By source tier</h3>
          <table className="w-full border border-line text-xs">
            <tbody>
              {(['tier1', 'tier2', 'tier3'] as const).map((t) => (
                <tr key={t} className="border-t border-line">
                  <td className={cell}>{t.replace('tier', 'Tier ')}</td>
                  <td className={`${cell} tabular-nums`}>{data.byTier[t] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Per sector</h3>
          <table className="w-full border border-line text-xs">
            <thead className="bg-paper">
              <tr><th className={th}>Sector</th><th className={th}>Qualified</th><th className={th}>Families</th><th className={th}>Short</th></tr>
            </thead>
            <tbody>
              {data.perSector.map((s) => (
                <tr key={s.vertical} className="border-t border-line">
                  <td className={cell}>{s.vertical}</td>
                  <td className={`${cell} tabular-nums`}>{s.qualified}</td>
                  <td className={`${cell} tabular-nums ${s.families.length > 0 && s.families.length < 3 ? 'text-marigold' : ''}`}>
                    {s.families.length === 0 ? '—' : `${s.families.length} (${s.families.join(', ')})`}
                  </td>
                  <td className={`${cell} tabular-nums ${s.shortfall > 0 ? 'text-marigold' : ''}`}>
                    {s.shortfall > 0 ? s.shortfall : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="mb-1 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Issuer qualification</h3>
          <table className="w-full border border-line text-xs">
            <tbody>
              {Object.entries(data.byQualification).sort((a, b) => b[1] - a[1]).map(([r, n]) => (
                <tr key={r} className="border-t border-line">
                  <td className={cell}>{r.replace(/-/g, ' ')}</td>
                  <td className={`${cell} tabular-nums`}>{n}</td>
                </tr>
              ))}
              {Object.keys(data.byQualification).length === 0 && (
                <tr><td className={cell} colSpan={2}>No qualification verdicts recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 font-mono text-[10px] text-slate-mid">
        {data.totalCompanies} companies on record · {data.quarantined} quarantined (kept with their evidence for audit) ·{' '}
        {data.humanReview} awaiting human review
      </p>
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: 'good' | 'warn' }) {
  const toneCls = tone === 'good' ? 'border-l-verde' : tone === 'warn' ? 'border-l-marigold' : 'border-l-line';
  return (
    <div className={`border border-line border-l-[3px] ${toneCls} bg-panel px-3 py-2`} title={hint}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">{label}</div>
      <div className="font-display text-xl font-bold leading-tight text-ink tabular-nums">{value}</div>
    </div>
  );
}
