import { useSearchParams } from 'react-router-dom';
import { useCompanies } from '../store/companies';
import { CompanyTable } from '../components/CompanyTable';
import { PageHeader } from '../components/ui';
import { verticalsFromParam } from '../data/taxonomy';

/**
 * All Deals: the master cross-vertical deal workspace — every retained
 * company (CSV imports + discovery imports), strongest fit first, with
 * search across all companies and filters across one or multiple
 * verticals plus stage/state/score/date/review. The five vertical pages
 * (Health & Wellness, FinTech, Future of Work, Sustainability, Frontier)
 * are pre-filtered views of this SAME table/query — not a separate
 * duplicated deal system — reached by passing `?vertical=` in the URL.
 * Screening actions (approve to HubSpot, generate outreach draft) live
 * inside each company's expanded detail — this is a discovery tool, not
 * a second CRM.
 *
 * `?vertical=` is normalized through `verticalsFromParam` so a legacy
 * bookmark (`?vertical=ai`, `robotics`, `spacetech`) resolves to the
 * right vertical instead of seeding an unmatchable filter, and so a
 * multi-vertical selection can be expressed as a comma-separated list.
 */
export function Companies() {
  const { companies, loaded, loadError } = useCompanies();
  const [params] = useSearchParams();

  return (
    <div>
      <PageHeader
        eyebrow="All Deals"
        title="All Deals"
        blurb="Every retained deal across every vertical, ranked by Vamos Fit Score. Search and filter across one or more verticals, then expand a row for the point-by-point score breakdown, the evidence behind it, and screening actions."
      />

      {loadError && (
        <div className="mb-4 rounded-md border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
          <span className="font-semibold text-alerta">Deal data unavailable.</span>{' '}
          {loadError} Start the API with <code className="rounded-sm bg-paper px-1 font-mono text-xs">npm run dev</code>.
        </div>
      )}
      {loaded && !loadError && companies.length === 0 && (
        <div className="mb-4 rounded-md border border-line bg-panel px-4 py-3 text-sm text-slate-mid">
          <span className="font-semibold text-ink">No deals are on record yet.</span>{' '}
          Run Deal Discovery against live public sources, or import a CSV under Settings.
        </div>
      )}

      <CompanyTable
        companies={companies}
        showVertical
        initialVerticals={verticalsFromParam(params.get('vertical'))}
        initialOpenId={params.get('c') ?? undefined}
      />
    </div>
  );
}
