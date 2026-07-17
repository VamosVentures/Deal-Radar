import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useCompanies } from '../store/companies';
import { scoreCompany } from '../lib/scoring';
import { VERTICALS } from '../data/taxonomy';
import { ExceptionBadge, PageHeader, StatCard } from '../components/ui';
import { Ranking } from '../components/Ranking';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const VERTICAL_ROUTE: Record<string, string> = {
  health: '/health',
  fintech: '/fintech',
  fow: '/future-of-work',
  sustainability: '/sustainability',
  aoi: '/areas-of-interest',
};

export function Overview() {
  const { companies, meta } = useCompanies();
  const [stealthCount, setStealthCount] = useState<number | null>(null);
  const [connectorFailures, setConnectorFailures] = useState<number | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState<number | null>(null);

  useEffect(() => {
    api.stealth.signals().then((r) => setStealthCount(r.signals.length)).catch(() => setStealthCount(null));
    api.refresh.connectors().then((r) => setConnectorFailures(r.connectors.filter((c) => c.state.lastSyncMode === 'failed' || c.state.lastError).length)).catch(() => setConnectorFailures(null));
    api.outreach.records().then((r) => setAwaitingApproval(r.records.filter((x) => x.outreachStatus === 'Draft Generated').length)).catch(() => setAwaitingApproval(null));
  }, []);

  const scored = useMemo(
    () => companies.map((c) => ({ c, fit: scoreCompany(c) })).sort((a, b) => b.fit.score - a.fit.score),
    [companies],
  );
  const exceptions = scored.filter((s) => s.fit.exceptions.length > 0);
  const verifiedTeams = companies.filter((c) => c.founders.some((f) => f.identity)).length;

  const mix = VERTICALS.map((v) => ({
    name: v.short,
    count: companies.filter((c) => c.vertical === v.id).length,
    core: v.core,
  }));

  const deadline = new Date('2026-07-24T00:00:00');
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 86400000));

  const DAY = 86_400_000;
  const newThisWeek = Object.values(meta).filter((m) => m.discoveredAt && Date.now() - new Date(m.discoveredAt).getTime() <= 7 * DAY).length;
  const eightPlus = scored.filter((s) => s.fit.score >= 8).length;
  const verificationNeeded = companies.filter((c) => !c.founders.some((f) => f.identity)).length;
  const staleRecords = companies.filter((c) => {
    const last = c.lastRefreshed ?? meta[c.id]?.lastRefreshed;
    return !last || Date.now() - new Date(last).getTime() > 30 * DAY;
  }).length;
  const unreviewed = Object.values(meta).filter((m) => m.reviewStatus === 'Needs Review').length;

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Sourcing radar — this week"
        blurb="Ranked by Vamos Fit Score (1.0–10.0). Every rank is auditable: expand a company on its vertical tab to see the point-by-point breakdown and the evidence behind it."
        right={
          <div className="text-right font-mono text-[11px] text-slate-mid">
            MVP deadline Jul 24 · <span className="font-bold text-marigold">{daysLeft} days</span>
          </div>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Tracked companies" value={companies.length} sub="across 4 core + adjacent" />
        <StatCard label="Newly discovered" value={newThisWeek} sub="imported this week" />
        <StatCard label="Top 10 / 8.0+" value={`${Math.min(10, scored.length)} / ${eightPlus}`} sub="ranked below" />
        <StatCard label="Stealth signals" value={stealthCount ?? '—'} sub="on the radar" />
        <StatCard label="Verified diverse-led" value={verifiedTeams} sub="self-ID / public statement only" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Verification needed" value={verificationNeeded} sub="no verified founder ID on record" />
        <StatCard label="Policy exceptions" value={exceptions.length} sub="flagged, never auto-rejected" />
        <StatCard label="Stale records" value={staleRecords} sub="not refreshed in 30 days" />
        <StatCard label="Unreviewed candidates" value={unreviewed} sub="imported, awaiting review" />
        <StatCard label="Awaiting approval / failures" value={`${awaitingApproval ?? '—'} / ${connectorFailures ?? '—'}`} sub="outreach drafts · connector errors" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Ranking />

        <div className="space-y-6">
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
                <span className="text-verde">■</span> core sectors&nbsp;&nbsp;<span className="text-marigold">■</span> adjacent interest
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Exceptions to review</h2>
            <ul className="space-y-2">
              {exceptions.map(({ c, fit }) => (
                <li key={c.id} className="rounded-md border border-alerta/30 bg-alerta-soft/60 px-3 py-2">
                  <Link to={VERTICAL_ROUTE[c.vertical]} className="text-sm font-semibold hover:text-alerta">{c.name}</Link>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} />)}
                  </div>
                </li>
              ))}
              {exceptions.length === 0 && <li className="text-xs text-slate-mid">No open policy exceptions.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
