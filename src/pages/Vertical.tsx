import { useMemo } from 'react';
import type { VerticalId } from '../types';
import { useCompanies } from '../store/companies';
import { verticalById } from '../data/taxonomy';
import { CompanyTable } from '../components/CompanyTable';
import { PageHeader } from '../components/ui';

export function VerticalPage({ id }: { id: VerticalId }) {
  const v = verticalById(id);
  const all = useCompanies().companies;
  const companies = useMemo(() => all.filter((c) => c.vertical === id), [all, id]);

  return (
    <div>
      <PageHeader
        eyebrow={v.core ? 'Core sector' : 'Adjacent interest — scored separately'}
        title={v.name}
        blurb={v.description}
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {v.subcategories.map((s) => (
          <span
            key={s.name}
            className={`rounded-sm border px-2 py-1 text-[11px] ${
              s.exception
                ? 'cursor-help border-alerta/40 bg-alerta-soft text-alerta'
                : 'border-line bg-panel text-slate-mid'
            }`}
            title={s.exception}
          >
            {s.name}
            {s.exception && ' ⚠'}
          </span>
        ))}
      </div>

      {!v.core && (
        <div className="mb-4 rounded-md border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-alerta">Adjacent-interest scoring.</span>{' '}
          Companies here are scored on a separate scale from the four core sectors (max 14/25 thesis-fit points).
          Hardware-heavy or off-thesis companies carry a visible <span className="font-semibold">Policy Exception</span> and require partner sign-off — they are flagged, never auto-rejected.
        </div>
      )}

      <CompanyTable companies={companies} subcategories={v.subcategories.map((s) => s.name)} />
    </div>
  );
}
