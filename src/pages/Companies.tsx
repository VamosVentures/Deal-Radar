import { useSearchParams } from 'react-router-dom';
import { useCompanies } from '../store/companies';
import { CompanyTable } from '../components/CompanyTable';
import { PageHeader } from '../components/ui';

/**
 * The review queue: every persisted company (CSV imports + discovery
 * imports), strongest fit first, with the primary filters (vertical,
 * stage, state) and free search. Screening actions (approve to
 * HubSpot, generate outreach draft) live inside each company's
 * expanded detail — this is a discovery tool, not a second CRM.
 */
export function Companies() {
  const { companies, loaded, loadError } = useCompanies();
  const [params] = useSearchParams();

  return (
    <div>
      <PageHeader
        eyebrow="Review queue"
        title="Companies"
        blurb="Every company on record, ranked by Vamos Fit Score. Expand a row for the point-by-point score breakdown, the evidence behind it, and screening actions."
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
        </div>
      )}

      <CompanyTable
        companies={companies}
        showVertical
        initialVertical={params.get('vertical') ?? undefined}
        initialOpenId={params.get('c') ?? undefined}
      />
    </div>
  );
}
