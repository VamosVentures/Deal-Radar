import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PortfolioCompany } from '../../shared/integrations';

/**
 * Real Vamos portfolio management: view, manual creation, and CSV
 * import (with per-row validation errors). Upserts by name — no
 * duplicates. Theme/evidence fields power the portfolio comparison;
 * when they're empty, the comparison says so instead of guessing.
 */
export function PortfolioPanel() {
  const [portfolio, setPortfolio] = useState<PortfolioCompany[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.imports.getPortfolio().then((r) => setPortfolio(r.portfolio)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const onCsv = async (file: File) => {
    setCsvMsg(null);
    setError(null);
    try {
      const res = await api.imports.importPortfolioCsv(await file.text());
      const skipNote = res.skipped.length > 0
        ? ` Rejected rows: ${res.skipped.map((s) => `row ${s.row} (${s.issues.join('; ')})`).join(' · ')}`
        : '';
      setCsvMsg(`${res.imported}/${res.total} portfolio compan${res.imported === 1 ? 'y' : 'ies'} imported (upserted by name).${skipNote}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="mt-6 border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Vamos portfolio ({portfolio.length})</h2>
        <span className="text-[11px] text-slate-mid">powers portfolio comparison — themes and evidence come only from what you record here</span>
        <div className="ml-auto flex gap-2">
          <label className="cursor-pointer rounded-[2px] border border-line px-2 py-1 text-xs">
            Import CSV
            <input type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onCsv(f); e.target.value = ''; }} />
          </label>
          <button className="rounded-[2px] bg-ink px-2 py-1 text-xs font-semibold text-white" onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? 'Close form' : '+ Add company'}
          </button>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-slate-mid">
        CSV columns: name, vertical, stage, status, website, publicDescription, investmentDate, themes, partnershipThemes, competitiveOverlapThemes, evidenceUrls (lists pipe-separated, e.g. <code className="rounded-[2px] bg-paper px-1 font-mono">payments|inclusion</code>).
      </p>
      {csvMsg && <p className="mt-2 rounded-[2px] bg-verde-soft px-2 py-1 text-xs text-verde">{csvMsg}</p>}
      {error && <p className="mt-2 text-xs text-alerta">{error}</p>}

      {showAdd && <AddPortfolioForm onSaved={() => { setShowAdd(false); load(); }} />}

      {portfolio.length === 0 ? (
        <p className="mt-3 text-xs text-slate-mid">No portfolio loaded. Comparisons will say so honestly rather than inventing overlap.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-slate-mid">
                <th className="py-1 pr-3">Company</th>
                <th className="py-1 pr-3">Vertical</th>
                <th className="py-1 pr-3">Stage</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Themes</th>
                <th className="py-1 pr-3">Partnership themes</th>
                <th className="py-1 pr-3">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.map((p) => (
                <tr key={p.name} className="border-b border-line align-top">
                  <td className="py-1.5 pr-3">
                    <span className="font-semibold">{p.name}</span>
                    {p.website && <a href={p.website} target="_blank" rel="noreferrer" className="ml-1 text-verde underline decoration-dotted">site</a>}
                    {p.investmentDate && <div className="font-mono text-[10px] text-slate-mid">invested {p.investmentDate}</div>}
                  </td>
                  <td className="py-1.5 pr-3">{p.vertical}</td>
                  <td className="py-1.5 pr-3">{p.stage}</td>
                  <td className="py-1.5 pr-3">{p.status}</td>
                  <td className="py-1.5 pr-3">{p.themes.join(', ') || <span className="text-slate-mid">—</span>}</td>
                  <td className="py-1.5 pr-3">{p.partnershipThemes.join(', ') || <span className="text-slate-mid">—</span>}</td>
                  <td className="py-1.5 pr-3">{p.evidenceUrls.length > 0 ? `${p.evidenceUrls.length} URL(s)` : <span className="text-slate-mid">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddPortfolioForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState({
    name: '', vertical: '', stage: '', status: 'Active', website: '',
    publicDescription: '', investmentDate: '', themes: '', partnershipThemes: '',
    competitiveOverlapThemes: '', evidenceUrls: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const list = (s: string) => s.split('|').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setErr(null);
    try {
      await api.imports.addPortfolioCompany({
        name: f.name, vertical: f.vertical, stage: f.stage, status: f.status || 'Active',
        website: f.website, publicDescription: f.publicDescription, investmentDate: f.investmentDate,
        themes: list(f.themes), partnershipThemes: list(f.partnershipThemes),
        competitiveOverlapThemes: list(f.competitiveOverlapThemes), evidenceUrls: list(f.evidenceUrls),
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const input = 'rounded-[2px] border border-line px-2 py-1 text-xs';
  return (
    <div className="mt-3 grid gap-1.5 rounded-[2px] border border-line bg-paper p-2 md:grid-cols-3">
      <input className={input} placeholder="Name *" value={f.name} onChange={set('name')} />
      <input className={input} placeholder="Vertical *" value={f.vertical} onChange={set('vertical')} />
      <input className={input} placeholder="Stage *" value={f.stage} onChange={set('stage')} />
      <input className={input} placeholder="Status" value={f.status} onChange={set('status')} />
      <input className={input} placeholder="Website" value={f.website} onChange={set('website')} />
      <input className={input} placeholder="Investment date (public only)" value={f.investmentDate} onChange={set('investmentDate')} />
      <input className={input + ' md:col-span-3'} placeholder="Public description" value={f.publicDescription} onChange={set('publicDescription')} />
      <input className={input} placeholder="Themes (a|b|c)" value={f.themes} onChange={set('themes')} />
      <input className={input} placeholder="Partnership themes (a|b)" value={f.partnershipThemes} onChange={set('partnershipThemes')} />
      <input className={input} placeholder="Competitive-overlap themes" value={f.competitiveOverlapThemes} onChange={set('competitiveOverlapThemes')} />
      <input className={input + ' md:col-span-3'} placeholder="Evidence URLs (url|url)" value={f.evidenceUrls} onChange={set('evidenceUrls')} />
      {err && <p className="text-xs text-alerta md:col-span-3">{err}</p>}
      <div className="md:col-span-3">
        <button onClick={save} className="rounded-[2px] bg-verde px-3 py-1 text-xs font-semibold text-white">Save (upserts by name)</button>
      </div>
    </div>
  );
}
