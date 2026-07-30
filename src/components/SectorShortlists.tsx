import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type HoldBackReason, type ShortlistsResponse } from '../lib/api';
import { SOURCE_LABELS } from '../../shared/opportunity';
import { verticalById } from '../data/taxonomy';
import type { VerticalId } from '../types';

/**
 * The per-sector shortlists, with every held-back live deal shown next to
 * the reason it lost its slot.
 *
 * The held-back list is the point of this panel. The selection rules
 * (evidence tier, recency, a cap per source family, five slots) all
 * REMOVE companies, and until now they removed them silently: a sector
 * reported "5 of 5" and the companies that had ranked sixth simply were
 * not anywhere in the product. A reviewer could not tell the difference
 * between "we considered it and it ranked below the cutoff" and "we never
 * had it", which are very different statements about a pipeline.
 */

const REASON_LABELS: Record<HoldBackReason, string> = {
  'ranked-below-cutoff': 'Ranked below cutoff',
  'source-family-cap': 'Source-family cap',
  'sector-limit': 'Sector limit',
  'insufficient-corroboration': 'Insufficient corroboration',
  quarantined: 'Quarantined',
};

export function SectorShortlists() {
  const [data, setData] = useState<ShortlistsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api.admin.shortlists()
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const heading = (
    <>
      <h2 className="mb-1 font-display text-base font-semibold text-ink">Sector shortlists</h2>
      <p className="mb-3 max-w-3xl text-xs text-slate-mid">
        Up to {data?.perSector ?? 5} opportunities per sector. Sectors are shown short rather than padded, and
        every live deal that did not take a slot is listed below its sector with the specific reason.
      </p>
    </>
  );

  if (err) return <section className="mt-8">{heading}<p className="text-xs text-alerta">{err}</p></section>;
  if (!data) return <section className="mt-8">{heading}<p className="text-xs text-slate-mid">Loading shortlists…</p></section>;

  return (
    <section className="mt-8">
      {heading}
      <p className="mb-3 text-xs text-slate-mid">
        <strong className="text-ink">{data.totalSelected}</strong> selected across {data.shortlists.length} sectors
        {' · '}
        <strong className="text-ink">{data.totalHeldBack}</strong> held back with a stated reason
      </p>

      <div className="space-y-3">
        {data.shortlists.map((s) => {
          const name = verticalById(s.vertical as VerticalId)?.name ?? s.vertical;
          const isOpen = open === s.vertical;
          return (
            <div key={s.vertical} className="border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : s.vertical)}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
                aria-expanded={isOpen}
              >
                <span className="font-display text-sm font-semibold text-ink">{name}</span>
                <span className="flex items-center gap-3 font-mono text-[11px] text-slate-mid">
                  <span className={s.shortfall > 0 ? 'text-marigold' : 'text-ink'}>
                    {s.selected.length}/{data.perSector} selected
                  </span>
                  {s.heldBack.length > 0 && <span>{s.heldBack.length} held back</span>}
                  <span aria-hidden>{isOpen ? '−' : '+'}</span>
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-slate-200 px-3 py-3">
                  {s.shortageExplanation && (
                    <div className="mb-3 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft px-3 py-2 text-xs text-marigold">
                      {s.shortageExplanation}
                    </div>
                  )}

                  {s.selected.length === 0 ? (
                    <p className="text-xs text-slate-mid">
                      No live deals in this sector. {s.leads} company lead{s.leads === 1 ? '' : 's'} on record with no
                      current financing evidence — the sector is shown empty rather than filled with them.
                    </p>
                  ) : (
                    <ol className="mb-3 space-y-1.5">
                      {s.selected.map((c, i) => (
                        <li key={c.companyId} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="font-mono text-[10px] text-slate-mid">{i + 1}.</span>
                          <Link to={`/companies?c=${encodeURIComponent(c.companyId)}`} className="font-semibold text-ink underline decoration-slate-300 hover:decoration-ink">
                            {c.name}
                          </Link>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
                            {SOURCE_LABELS[c.primarySourceId] ?? c.primarySourceId} · tier {c.primaryTier}
                          </span>
                          {c.roundType && <span className="text-slate-mid">{c.roundType}</span>}
                          {c.amountText && <span className="text-slate-mid">{c.amountText}</span>}
                          {c.evidencePublishedAt && <span className="font-mono text-[10px] text-slate-mid">{c.evidencePublishedAt}</span>}
                          <a href={c.evidenceUrl} target="_blank" rel="noreferrer noopener" className="font-mono text-[10px] text-verde underline">
                            evidence ↗
                          </a>
                        </li>
                      ))}
                    </ol>
                  )}

                  {s.heldBack.length > 0 && (
                    <>
                      <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-mid">
                        Held back — {s.heldBack.length} live deal{s.heldBack.length === 1 ? '' : 's'} considered and not selected
                      </h3>
                      <ul className="space-y-1.5">
                        {s.heldBack.map((h) => (
                          <li key={h.companyId} className="border-l-[3px] border-l-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <Link to={`/companies?c=${encodeURIComponent(h.companyId)}`} className="font-semibold text-ink underline decoration-slate-300 hover:decoration-ink">
                                {h.name}
                              </Link>
                              <span className="border border-slate-300 bg-white px-1 font-mono text-[9px] uppercase tracking-wider text-slate-mid">
                                {REASON_LABELS[h.reasonCode]}
                              </span>
                              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
                                {SOURCE_LABELS[h.primarySourceId] ?? h.primarySourceId}
                              </span>
                              <a href={h.evidenceUrl} target="_blank" rel="noreferrer noopener" className="font-mono text-[10px] text-verde underline">
                                evidence ↗
                              </a>
                            </div>
                            <p className="mt-0.5 text-slate-mid">{h.reason}</p>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
