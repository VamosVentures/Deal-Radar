import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useCompanies } from '../store/companies';
import { VERTICALS } from '../data/taxonomy';
import { PageHeader } from '../components/ui';
import { KpiCard, KpiSection } from '../components/KpiCard';
import { KpiBreakdownModal } from '../components/KpiBreakdownModal';
import { Ranking } from '../components/Ranking';
import { SectorShortlists } from '../components/SectorShortlists';
import { api } from '../lib/api';
import { DEFAULT_STALE_SETTINGS, type StaleSettings } from '../../shared/integrations';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import { CUMULATIVE_PERIODS, type CumulativePeriod, type CumulativePeriodResult, type EntityKpis, type ExecutiveKpis, type VerticalBreakdown } from '../../shared/executiveKpis';

type KpiEntityKind = 'companies' | 'founders';
/**
 * The five card concepts Marcos asked for, mirrored for both entities.
 * Backend field names are unchanged from the prior pass (`hot` still
 * means "High-Fit", the underlying formula is identical) — only the
 * on-screen labels and card set changed. `lastRun` is still computed
 * and returned by the API for other consumers; it is deliberately not
 * one of the five cards rendered here anymore.
 */
type KpiMetricKind = 'discoveredThisWeek' | 'hot' | 'stale' | 'awaitingReview' | 'cumulative';
const METRIC_ORDER: KpiMetricKind[] = ['discoveredThisWeek', 'hot', 'stale', 'awaitingReview', 'cumulative'];

const METRIC_LABEL: Record<KpiMetricKind, (entity: KpiEntityKind) => string> = {
  discoveredThisWeek: () => 'Discovered This Week',
  hot: (e) => (e === 'companies' ? 'High-Fit Companies' : 'High-Fit Founders'),
  stale: (e) => (e === 'companies' ? 'Stale Companies' : 'Stale Founders'),
  awaitingReview: () => 'Awaiting Review',
  cumulative: (e) => (e === 'companies' ? 'Cumulative Companies' : 'Cumulative Founders'),
};
const METRIC_TONE: Record<KpiMetricKind, 'ink' | 'verde' | 'marigold' | 'alerta'> = {
  discoveredThisWeek: 'ink', hot: 'verde', stale: 'alerta', awaitingReview: 'marigold', cumulative: 'ink',
};
const ENTITY_LABEL: Record<KpiEntityKind, string> = { companies: 'Companies', founders: 'Stealth Founders' };

const PERIOD_LABEL: Record<CumulativePeriod, string> = {
  'all-time': 'All Time', 'this-month': 'This Month', 'last-month': 'Last Month', 'this-year': 'This Year', 'last-year': 'Last Year',
};

/** Formats in UTC, not the viewer's local zone — the boundary itself is UTC (see shared/executiveKpis.ts), so displaying it in local time would show a different, wrong-looking date right around midnight UTC. */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function metricDetail(entity: KpiEntityKind, metric: KpiMetricKind): string {
  const noun = entity === 'companies' ? 'companies' : 'stealth founders';
  switch (metric) {
    case 'discoveredThisWeek':
      return `Retained sourced ${noun} whose effective discovery date falls in the current calendar week (ISO-8601, Monday–Sunday, UTC).`;
    case 'hot':
      return `${entity === 'companies' ? 'Companies scoring' : 'Stealth founders whose associated company scores'} ${HOT_THRESHOLD.toFixed(1)} or higher on the VamosVentures Fit Score. Provisional scores (no company-descriptive evidence yet) are excluded${entity === 'founders' ? ', and rejected candidates never count here regardless of their company\'s score' : ''}.`;
    case 'stale':
      return `${entity === 'companies' ? 'Companies' : 'Stealth founders'} not reviewed by a team member in 7 or more days — a human review action only; automated refreshes/enrichment never count. Includes records that have never been reviewed at all, once they've existed 7+ days.`;
    case 'awaitingReview':
      return entity === 'companies'
        ? 'Active, non-quarantined companies whose review status is still New or Awaiting Review — the same review-queue predicate the application has always used.'
        : 'Founder candidates with no confirm/reject decision yet — the same predicate the Stealth Radar review action already uses.';
    case 'cumulative':
      return `Retained ${noun} on record, across every status — including Passed, Monitor, and (for founders) rejected candidates. Excludes confirmed duplicates. Does not include any record that was later permanently deleted. Use the period selector below to filter by effective discovery date.`;
  }
}

/**
 * Overview: the executive KPI dashboard — Companies and Stealth
 * Founders, five cards each (see shared/executiveKpis.ts for exact
 * formulas) — plus the fit ranking and sector coverage.
 */
export function Overview() {
  const { companies, meta, loaded, loadError } = useCompanies();
  const [staleSettings, setStaleSettings] = useState<StaleSettings>(DEFAULT_STALE_SETTINGS);
  useEffect(() => {
    api.staleSettings.get().then(setStaleSettings).catch(() => setStaleSettings(DEFAULT_STALE_SETTINGS));
  }, []);

  const [kpis, setKpis] = useState<ExecutiveKpis | null>(null);
  const [kpisError, setKpisError] = useState<string | null>(null);
  useEffect(() => {
    api.overview.kpis()
      .then((data) => { setKpis(data); setKpisError(null); })
      .catch((e) => setKpisError(e instanceof Error ? e.message : 'Request failed.'));
  }, []);

  const [openModal, setOpenModal] = useState<{ entity: KpiEntityKind; metric: KpiMetricKind } | null>(null);
  const [cumulativePeriod, setCumulativePeriod] = useState<CumulativePeriod>('all-time');
  const [cumulativeOverride, setCumulativeOverride] = useState<CumulativePeriodResult | null>(null);
  const [cumulativeLoading, setCumulativeLoading] = useState(false);
  /**
   * A failed period query has to be VISIBLE.
   *
   * This used to `.catch(() => setCumulativeOverride(null))`, and null is
   * also the "All Time is selected" state — so a failed request for
   * "Last Month" fell back to the All-Time breakdown while the heading
   * kept reading "Last Month". The number on screen was real, and the
   * label above it was wrong, with nothing to indicate either.
   */
  const [cumulativeError, setCumulativeError] = useState<string | null>(null);

  useEffect(() => {
    if (!openModal || openModal.metric !== 'cumulative') return;
    if (cumulativePeriod === 'all-time') { setCumulativeOverride(null); setCumulativeError(null); return; }
    setCumulativeLoading(true);
    setCumulativeError(null);
    api.overview.cumulativePeriod(openModal.entity, cumulativePeriod)
      .then((r) => { setCumulativeOverride(r); setCumulativeError(null); })
      .catch((e: unknown) => {
        setCumulativeOverride(null);
        setCumulativeError((e as Error).message || 'Could not load this period.');
      })
      .finally(() => setCumulativeLoading(false));
  }, [openModal, cumulativePeriod]);

  const openKpiModal = (entity: KpiEntityKind, metric: KpiMetricKind) => {
    setCumulativePeriod('all-time');
    setCumulativeOverride(null);
    setCumulativeError(null);
    setOpenModal({ entity, metric });
  };
  const closeKpiModal = () => {
    setOpenModal(null);
    setCumulativePeriod('all-time');
    setCumulativeOverride(null);
    setCumulativeError(null);
  };

  // Staleness here is computed server-side (companyMetaView) using the
  // administrator-configurable threshold (Settings → Stale-record
  // settings) — a DIFFERENT, older concept from the fixed-7-day
  // "Stale Companies" executive KPI card above; both are real and
  // intentionally independent (see shared/executiveKpis.ts header
  // comment). This list is kept because, unlike the KPI card, it names
  // the specific companies for quick navigation.
  const staleCompanies = companies.filter((c) => meta[c.id]?.stale);

  const mix = VERTICALS.map((v) => ({
    name: v.short,
    count: companies.filter((c) => c.vertical === v.id).length,
  }));

  const kpiFor = (entity: KpiEntityKind): EntityKpis | null => (entity === 'companies' ? kpis?.companies ?? null : kpis?.founders ?? null);
  const breakdownFor = (entity: KpiEntityKind, metric: KpiMetricKind): VerticalBreakdown | null => {
    const k = kpiFor(entity);
    if (metric === 'cumulative' && openModal?.entity === entity) {
      if (cumulativeOverride) return cumulativeOverride;
      /**
       * A non-All-Time period with no result yet returns NULL rather than
       * the All-Time figure. `k.cumulative` is always All Time
       * (shared/executiveKpis.ts), so returning it here while the heading
       * says "Last Month" states a number for a window it was not
       * computed over. Null renders as loading or as the error, which is
       * what is actually true.
       */
      if (cumulativePeriod !== 'all-time') return null;
    }
    if (!k) return null;
    return metric === 'discoveredThisWeek' ? k.discoveredThisWeek : k[metric];
  };
  const cardValue = (entity: KpiEntityKind, metric: KpiMetricKind): number | undefined => {
    const k = kpiFor(entity);
    if (!k) return undefined;
    return metric === 'discoveredThisWeek' ? k.discoveredThisWeek.total : k[metric].total;
  };

  const periodLabelFor = (entity: KpiEntityKind, metric: KpiMetricKind): string | null => {
    const k = kpiFor(entity);
    if (metric === 'discoveredThisWeek' && k) {
      return `Week of ${fmtDate(k.discoveredThisWeek.weekStart)} (Mon–Sun, UTC)`;
    }
    if (metric === 'cumulative') {
      if (cumulativeOverride) return `${PERIOD_LABEL[cumulativeOverride.period]} (${cumulativeOverride.from ? fmtDate(cumulativeOverride.from) : '…'} – ${cumulativeOverride.to ? fmtDate(cumulativeOverride.to) : 'present'})`;
      if (cumulativePeriod !== 'all-time') {
        return `${PERIOD_LABEL[cumulativePeriod]} — ${cumulativeLoading ? 'loading…' : 'not loaded'}`;
      }
      return PERIOD_LABEL[cumulativePeriod];
    }
    return null;
  };

  /**
   * Partial-run disclosure.
   *
   * `KpiCard.warning` and `KpiBreakdownModal.partialRunNote` were both
   * built, documented and rendered — and neither had a single caller, so
   * a run that completed with sources failing produced a normal-looking
   * number with nothing anywhere to say it was incomplete. That is the
   * one thing the requirement forbids: a partial run may contribute
   * results, but it must visibly display its partial status.
   *
   * Scoped to the two metrics that COUNT records a run produced.
   * `awaitingReview`, `stale` and `hot` are states of records already on
   * file, and badging them would over-claim — a failing source does not
   * make a review queue partial.
   */
  const RUN_DEPENDENT: KpiMetricKind[] = ['discoveredThisWeek', 'cumulative'];

  const partialRunFor = (entity: KpiEntityKind, metric: KpiMetricKind) => {
    if (!RUN_DEPENDENT.includes(metric)) return null;
    const run = kpiFor(entity)?.lastRun;
    if (!run?.isPartial) return null;
    return {
      completedAt: run.runCompletedAt,
      warningCount: run.warningCount,
      affectedSources: run.affectedSources,
    };
  };

  const renderCard = (entity: KpiEntityKind, metric: KpiMetricKind) => {
    const value = cardValue(entity, metric);
    const partial = partialRunFor(entity, metric);
    return (
      <KpiCard
        key={metric}
        label={METRIC_LABEL[metric](entity)}
        value={value ?? '—'}
        loading={!kpis && !kpisError}
        tone={METRIC_TONE[metric]}
        warning={partial
          ? `The most recent contributing run completed with warnings — `
            + `${partial.warningCount} source(s) failed or were skipped`
            + `${partial.affectedSources.length > 0 ? ` (${partial.affectedSources.join(', ')})` : ''}. `
            + 'This count may be incomplete.'
          : undefined}
        onOpen={() => openKpiModal(entity, metric)}
      />
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Sourcing radar — this week"
        blurb="Ranked by VamosVentures Fit Score (1.0–10.0). Every rank is auditable: open a company to see the point-by-point breakdown and the evidence behind it."
      />

      {loadError && (
        <div className="mb-5 border border-alerta/40 border-l-[3px] border-l-alerta bg-alerta-soft px-4 py-3 text-sm">
          <span className="font-semibold text-alerta">Company data unavailable.</span>{' '}
          {loadError} Start the API with <code className="rounded-[2px] bg-paper px-1 font-mono text-xs">npm run dev</code>.
        </div>
      )}
      {loaded && !loadError && companies.length === 0 && (
        <div className="mb-5 border border-line bg-panel px-4 py-3 text-sm text-slate-mid">
          <span className="font-semibold text-ink">No companies are on record yet.</span>{' '}
          Run Deal Discovery against live public sources, or import a CSV under Settings.
          Nothing is pre-populated: every record here comes from a real import you can audit.
        </div>
      )}

      {kpisError && (
        <div className="mb-4 border border-alerta/40 border-l-[3px] border-l-alerta bg-alerta-soft px-4 py-3 text-sm">
          <span className="font-semibold text-alerta">KPI data unavailable.</span> {kpisError}
        </div>
      )}
      {kpis?.partial && (
        <div className="mb-4 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft px-4 py-3 text-sm">
          <span className="font-semibold text-marigold">Partial KPI data.</span>{' '}
          {kpis.errors.join(' ')} The KPIs below that did load reflect real, current data.
        </div>
      )}

      <KpiSection title="Companies">
        {METRIC_ORDER.map((metric) => renderCard('companies', metric))}
      </KpiSection>

      <KpiSection title="Stealth Founders">
        {METRIC_ORDER.map((metric) => renderCard('founders', metric))}
      </KpiSection>

      {kpis?.lastUpdated && (
        <div className="-mt-3 mb-5 font-mono text-[10px] uppercase tracking-wider text-slate-mid">
          KPIs last updated {new Date(kpis.lastUpdated).toLocaleString()}
        </div>
      )}

      {openModal && (
        <KpiBreakdownModal
          title={`${ENTITY_LABEL[openModal.entity]} — ${METRIC_LABEL[openModal.metric](openModal.entity)}`}
          eyebrow="Executive Overview"
          breakdown={breakdownFor(openModal.entity, openModal.metric)}
          error={cumulativeError ?? kpisError}
          partialRunNote={partialRunFor(openModal.entity, openModal.metric)}
          lastUpdated={kpis?.lastUpdated ?? null}
          detail={metricDetail(openModal.entity, openModal.metric)}
          periodLabel={periodLabelFor(openModal.entity, openModal.metric)}
          periodSelector={openModal.metric === 'cumulative' ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Time period">
              {CUMULATIVE_PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={cumulativeLoading}
                  onClick={() => setCumulativePeriod(p)}
                  aria-pressed={cumulativePeriod === p}
                  className={`rounded-[2px] border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-default disabled:opacity-50 ${
                    cumulativePeriod === p ? 'border-marigold bg-marigold-soft text-marigold' : 'border-line bg-panel text-slate-mid hover:border-marigold hover:text-marigold'
                  }`}
                >
                  {PERIOD_LABEL[p]}
                </button>
              ))}
              {cumulativeLoading && <span className="self-center text-[10px] text-slate-mid">Loading…</span>}
            </div>
          ) : undefined}
          onClose={closeKpiModal}
        />
      )}

      {staleSettings.showStaleOnOverview && staleCompanies.length > 0 && (
        <div className="mt-4 border border-alerta/30 border-l-[3px] border-l-alerta bg-panel px-4 py-3 text-xs">
          <span className="font-mono uppercase tracking-widest text-alerta">
            Stale companies (admin threshold: {staleSettings.staleAfterDays}+ days){staleCompanies.length > staleSettings.maxStaleOnOverview ? ` (showing ${staleSettings.maxStaleOnOverview} of ${staleCompanies.length})` : ''}
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

      <div className="mt-8 grid gap-8 xl:grid-cols-[1fr_320px]">
        <Ranking />

        <section>
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Coverage by sector</h2>
          <div className="border border-line bg-panel p-3.5">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={mix} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fontFamily: 'JetBrains Mono', fill: 'var(--color-slate-mid)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fontFamily: 'JetBrains Mono', fill: 'var(--color-slate-mid)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--color-marigold-soft)' }} contentStyle={{ fontSize: 12, borderRadius: 2, borderColor: 'var(--color-line)', fontFamily: 'Inter' }} />
                <Bar dataKey="count" radius={[1, 1, 0, 0]}>
                  {mix.map((m) => (
                    <Cell key={m.name} fill="var(--color-verde)" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <SectorShortlists />
    </div>
  );
}
