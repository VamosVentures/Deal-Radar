import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Company } from '../types';
import { scoreCompany } from '../lib/scoring';
import { verticalById } from '../data/taxonomy';
import { usePipeline } from '../store/pipeline';
import { ExceptionBadge, FounderLine, IdentityChips, ScoreGauge } from './ui';
import { HubSpotModal } from './HubSpotModal';
import { OutreachPanel } from './OutreachPanel';
import { AiAnalysis } from './AiAnalysis';
import { useCompanies } from '../store/companies';
import { btnGhost, btnPrimary } from './Modal';

type IdentityFilter = 'all' | 'latino' | 'female' | 'any-verified';

export function CompanyTable({
  companies,
  showVertical = false,
  subcategories,
}: {
  companies: Company[];
  showVertical?: boolean;
  subcategories?: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [stage, setStage] = useState('all');
  const [sub, setSub] = useState('all');
  const [identity, setIdentity] = useState<IdentityFilter>('all');
  const [q, setQ] = useState('');
  const pipeline = usePipeline();

  const rows = useMemo(() => {
    return companies
      .map((c) => ({ c, fit: scoreCompany(c) }))
      .filter(({ c }) => {
        if (stage !== 'all' && c.stage !== stage) return false;
        if (sub !== 'all' && c.subcategory !== sub) return false;
        if (identity !== 'all') {
          const ids = c.founders.map((f) => f.identity).filter(Boolean);
          if (identity === 'any-verified' && ids.length === 0) return false;
          if (identity === 'latino' && !ids.some((i) => i?.latinoLed)) return false;
          if (identity === 'female' && !ids.some((i) => i?.femaleLed)) return false;
        }
        const hay = `${c.name} ${c.oneLiner} ${c.city} ${c.state} ${c.founders.map((f) => f.name).join(' ')}`.toLowerCase();
        return hay.includes(q.toLowerCase());
      })
      .sort((a, b) => b.fit.score - a.fit.score);
  }, [companies, stage, sub, identity, q]);

  const select = 'rounded-sm border border-line bg-panel px-2 py-1.5 text-xs';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, founder, city…"
          className={`${select} w-56`}
          aria-label="Search companies"
        />
        <select className={select} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="all">All stages</option>
          {['Pre-seed', 'Seed', 'Series A'].map((s) => <option key={s}>{s}</option>)}
        </select>
        {subcategories && (
          <select className={select} value={sub} onChange={(e) => setSub(e.target.value)} aria-label="Filter by subcategory">
            <option value="all">All subcategories</option>
            {subcategories.map((s) => <option key={s}>{s}</option>)}
          </select>
        )}
        <select className={select} value={identity} onChange={(e) => setIdentity(e.target.value as IdentityFilter)} aria-label="Filter by verified team indicators">
          <option value="all">All teams</option>
          <option value="latino">Latino-led (verified)</option>
          <option value="female">Female-led (verified)</option>
          <option value="any-verified">Any verified indicator</option>
        </select>
        <span className="ml-auto font-mono text-[11px] text-slate-mid">{rows.length} compan{rows.length === 1 ? 'y' : 'ies'}</span>
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-panel">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-slate-mid">
              <th className="px-3 py-2">Fit</th>
              <th className="px-3 py-2">Company</th>
              {showVertical && <th className="px-3 py-2">Vertical</th>}
              <th className="px-3 py-2">Subcategory</th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">HQ</th>
              <th className="px-3 py-2">Verified team</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={showVertical ? 8 : 7} className="px-3 py-8 text-center text-slate-mid">
                  No companies match these filters. Clear a filter or add companies from Data Sources.
                </td>
              </tr>
            )}
            {rows.map(({ c, fit }) => {
              const open = openId === c.id;
              const inPipeline = pipeline.items.some((i) => i.companyId === c.id);
              return (
                <FragmentRow key={c.id}>
                  <tr
                    className={`cursor-pointer border-b border-line align-top transition-colors hover:bg-marigold-soft/40 ${open ? 'bg-marigold-soft/40' : ''}`}
                    onClick={() => setOpenId(open ? null : c.id)}
                  >
                    <td className="px-3 py-2.5"><ScoreGauge score={fit.score} /></td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold">{c.name}</div>
                      <div className="max-w-xs text-xs text-slate-mid">{c.oneLiner}</div>
                      {fit.exceptions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} />)}
                        </div>
                      )}
                    </td>
                    {showVertical && <td className="px-3 py-2.5 text-xs">{verticalById(c.vertical).name}</td>}
                    <td className="px-3 py-2.5 text-xs">{c.subcategory}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs font-medium">{c.stage}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs">{c.city}, {c.state}</td>
                    <td className="px-3 py-2.5"><IdentityChips founders={c.founders} /></td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); pipeline.addToPipeline(c.id); }}
                        disabled={inPipeline}
                        className="rounded-sm border border-line px-2 py-1 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-marigold hover:text-marigold disabled:cursor-default disabled:opacity-40"
                      >
                        {inPipeline ? 'In pipeline' : '+ Pipeline'}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={showVertical ? 8 : 7} className="px-4 py-4">
                        <CompanyDetail c={c} />
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// React fragments can't carry keys inside <tbody> mapping neatly with two rows,
// so wrap the pair. Using a plain fragment component keeps the table valid.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function CompanyDetail({ c }: { c: Company }) {
  const fit = scoreCompany(c);
  const { meta } = useCompanies();
  const m = meta[c.id];
  const [modal, setModal] = useState<'hubspot' | 'outreach' | null>(null);
  return (
    <div>
      {m && (m.reviewStatus || m.discoverySource || (m.addedEvidence?.length ?? 0) > 0) && (
        <div className="mb-3 rounded-sm border border-marigold/40 bg-marigold-soft/50 px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-1.5">
            {m.reviewStatus && <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-marigold">{m.reviewStatus}</span>}
            {m.discoverySource && <span className="rounded-sm bg-paper px-1.5 py-0.5 font-mono text-[10px] text-slate-mid">discovered via {m.discoverySource}{m.discoveredAt ? ` on ${m.discoveredAt}` : ''}</span>}
          </div>
          {(m.addedEvidence?.length ?? 0) > 0 && (
            <div className="mt-1.5">
              <span className="font-semibold text-ink">Evidence added from discovery (appended, never overwritten):</span>
              <ul className="mt-0.5 list-disc pl-4 text-slate-mid">
                {m.addedEvidence!.map((e, i) => (
                  <li key={i}>{e.claim} — {e.source}, {e.date} (<a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">source</a>)</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-line bg-panel px-3 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
          Team actions — every external step gets a human review screen first
        </span>
        <span className="ml-auto flex gap-2">
          <button className={btnPrimary} onClick={() => setModal('hubspot')}>
            Approve &amp; add to HubSpot
          </button>
          <button className={btnGhost} onClick={() => setModal('outreach')}>
            Generate founder outreach
          </button>
        </span>
      </div>
      {modal === 'hubspot' && <HubSpotModal c={c} onClose={() => setModal(null)} />}
      {modal === 'outreach' && <OutreachPanel c={c} onClose={() => setModal(null)} />}
      <AiAnalysis c={c} />
      <div className="grid gap-5 lg:grid-cols-2">
      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
          Score breakdown — {fit.totalPoints}/100 pts → {fit.score.toFixed(1)}/10
        </h3>
        <ul className="space-y-2">
          {fit.components.map((comp) => (
            <li key={comp.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{comp.label}</span>
                <span className="font-mono text-xs font-semibold">{comp.points}/{comp.max}</span>
              </div>
              <div className="mt-0.5 h-1 w-full rounded-sm bg-line">
                <div className="h-1 rounded-sm bg-verde" style={{ width: `${(comp.points / comp.max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-slate-mid">{comp.rationale}</p>
            </li>
          ))}
        </ul>
        {fit.exceptions.length > 0 && (
          <div className="mt-3 space-y-2">
            {fit.exceptions.map((e) => (
              <div key={e.flag} className="rounded-sm border border-alerta/40 bg-alerta-soft px-3 py-2 text-xs text-alerta">
                <ExceptionBadge flag={e.flag} /> <span className="mt-1 block text-ink/80">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Founders</h3>
        <div className="space-y-1.5">{c.founders.map((f) => <FounderLine key={f.name} f={f} />)}</div>

        <h3 className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
          Evidence ({c.evidence.length})
        </h3>
        <ul className="space-y-2">
          {c.evidence.map((e) => (
            <li key={e.url} className="rounded-sm border border-line bg-panel px-3 py-2 text-xs">
              <div className="font-medium text-ink">{e.claim}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-slate-mid">
                <span className="rounded-sm bg-paper px-1 py-0.5 font-mono text-[10px] uppercase">{e.type}</span>
                <a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{e.source}</a>
                <span className="font-mono">{e.date}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-xs text-slate-mid">
          {c.raising ? <>Raising: <span className="font-semibold text-ink">{c.raising}</span> · </> : null}
          Founded {c.foundedYear} · Team of {c.teamSize}
          {c.website && <> · <a href={c.website} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{c.website.replace('https://', '')}</a></>}
        </div>
      </section>
      </div>
    </div>
  );
}
