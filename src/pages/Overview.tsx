import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useCompanies } from '../store/companies';
import { scoreCompany } from '../lib/scoring';
import { VERTICALS } from '../data/taxonomy';
import { PageHeader, StatCard } from '../components/ui';
import { Ranking } from '../components/Ranking';
import { api } from '../lib/api';
import { DEFAULT_STALE_SETTINGS, type StaleSettings } from '../../shared/integrations';

const DAY = 86_400_000;
const HIGH_FIT_THRESHOLD = 8.0;

/**
 * Overview: four live, actionable metrics — all computed from
 * persisted records (no fabricated comparisons, no technical
 * counters) — plus the fit ranking and sector coverage.
 */
export function Overview() {
  const { companies, meta, loaded, loadError } = useCompanies();
  const [staleSettings, setStaleSettings] = useState<StaleSettings>(DEFAULT_STALE_SETTINGS);
  useEffect(() => {
    api.staleSettings.get().then(setStaleSettings).catch(() => setStaleSettings(DEFAULT_STALE_SETTINGS));
  }, []);

  const scored = useMemo(
    () => companies.map((c) => ({ c, fit: scoreCompany(c) })).sort((a, b) => b.fit.score - a.fit.score),
    [companies],
  );

  const discoveredThisWeek = Object.values(meta).filter(
    (m) => m.discoveredAt && Date.now() - new Date(m.discoveredAt).getTime() <= 7 * DAY,
  ).length;
  const highFit = scored.filter((s) => s.fit.score >= HIGH_FIT_THRESHOLD).length;
  const awaitingReview = companies.filter((c) => {
    const status = meta[c.id]?.reviewStatus ?? 'New';
    return status === 'New' || status === 'Awaiting Review';
  }).length;
  // Staleness is computed server-side (companyMetaView) using the
  // administrator-configurable threshold and per-status inclusion
  // (Settings → Stale-record settings) — not a hardcoded 30 days.
  const staleCompanies = companies.filter((c) => meta[c.id]?.stale);
  const stale = staleCompanies.length; // the count itself is never capped, honest even if the list below is

  const mix = VERTICALS.map((v) => ({
    name: v.short,
    count: companies.filter((c) => c.vertical === v.id).length,
    core: v.core,
  }));

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Sourcing radar — this week"
        blurb="Ranked by Vamos Fit Score (1.0–10.0). Every rank is auditable: open a company to see the point-by-point breakdown and the evidence behind it."
      />

      {loadError && (
        <div className="mb-4 rounded-md border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
          <span className="font-semibold text-alerta">Company data unavailable.</span>{' '}
          {loadError} Start the API with <code className="rounded-sm bg-paper px-1 font-mono text-xs">npm run dev</code>.
        </div>
      )}
      {loaded && !loadError && companies.length === 0 && (
        <div className="mb-4 rounded-md border border-line bg-panel px-4 py-3 text-sm text-slate-mid">
          <span className="font-semibold text-ink">No companies are on record yet.</span>{' '}
          Run Deal Discovery against live public sources, or import a CSV under Settings.
          Nothing is pre-populated: every record here comes from a real import you can audit.
        </div>
      )}

      <div className={`mb-6 grid grid-cols-2 gap-3 ${staleSettings.showStaleOnOverview ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <StatCard
          label="Discovered this week"
          value={discoveredThisWeek}
          sub={discoveredThisWeek === 1 ? '1 company imported in the last 7 days' : `${discoveredThisWeek} companies imported in the last 7 days`}
        />
        <StatCard
          label="High-fit companies"
          value={highFit}
          sub={`${highFit === 1 ? '1 company' : `${highFit} companies`} scored ${HIGH_FIT_THRESHOLD.toFixed(1)} or higher`}
        />
        <StatCard
          label="Awaiting review"
          value={awaitingReview}
          sub={`${awaitingReview === 1 ? '1 company needs' : `${awaitingReview} companies need`} a first review`}
        />
        {staleSettings.showStaleOnOverview && (
          <StatCard
            label="Stale companies"
            value={stale}
            sub={`${stale === 1 ? '1 company' : `${stale} companies`} not refreshed in ${staleSettings.staleAfterDays}+ days`}
          />
        )}
      </div>

      {staleSettings.showStaleOnOverview && staleCompanies.length > 0 && (
        <div className="mb-6 rounded-md border border-line bg-panel px-4 py-3 text-xs">
          <span className="font-mono uppercase tracking-widest text-slate-mid">
            Stale companies{staleCompanies.length > staleSettings.maxStaleOnOverview ? ` (showing ${staleSettings.maxStaleOnOverview} of ${staleCompanies.length})` : ''}
          </span>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {staleCompanies.slice(0, staleSettings.maxStaleOnOverview).map((c) => (
              <li key={c.id}>
                <Link to={`/companies?c=${c.id}`} className="text-verde underline decoration-dotted">{c.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Ranking />

        <section>
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Coverage by sector</h2>
          <div className="rounded-md border border-line bg-panel p-3">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={mix} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--color-marigold-soft)' }} contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: 'var(--color-line)' }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {mix.map((m) => (
                    <Cell key={m.name} fill={m.core ? 'var(--color-verde)' : 'var(--color-marigold)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-1 font-mono text-[10px] text-slate-mid">
              <span className="text-verde">■</span> core sectors&nbsp;&nbsp;<span className="text-marigold">■</span> other industries
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
