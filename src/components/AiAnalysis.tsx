import { useState } from 'react';
import type { Company } from '../types';
import { scoreCompany } from '../lib/scoring';
import { verticalById } from '../data/taxonomy';
import { api, ApiError } from '../lib/api';
import type { FitExplainContext, FitExplanation, PortfolioComparison } from '../../shared/integrations';
import { btnGhost, ErrorNote } from './Modal';

/**
 * AI analysis actions on the company detail view. Both analyses are
 * built ONLY from the audited score components and exceptions — the
 * backend validates the structured output with Zod, caches results,
 * and answers with a deterministic local template when no AI key is
 * configured. Output is always labeled (Local template / AI / cached)
 * and is advisory text a human reads — it approves or rejects nothing.
 */
export function AiAnalysis({ c }: { c: Company }) {
  const fit = scoreCompany(c);
  const [explanation, setExplanation] = useState<FitExplanation | null>(null);
  const [comparison, setComparison] = useState<PortfolioComparison | null>(null);
  const [loading, setLoading] = useState<'fit' | 'portfolio' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const context: FitExplainContext = {
    companyId: c.id,
    companyName: c.name,
    vertical: verticalById(c.vertical)?.name ?? c.vertical,
    subcategory: c.subcategory,
    stage: c.stage,
    score: fit.score,
    components: fit.components.map((x) => ({ label: x.label, points: x.points, max: x.max, rationale: x.rationale })),
    exceptions: fit.exceptions.map((e) => e.message),
  };

  async function run(kind: 'fit' | 'portfolio') {
    setLoading(kind);
    setError(null);
    try {
      if (kind === 'fit') setExplanation(await api.ai.explainFit(context));
      else setComparison(await api.ai.comparePortfolio(context));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(null);
    }
  }

  return (
    <section className="mt-5 border border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
          AI analysis — advisory only, built from the audited score data
        </span>
        <span className="ml-auto flex gap-2">
          <button className={btnGhost} onClick={() => run('fit')} disabled={loading !== null}>
            {loading === 'fit' ? 'Explaining…' : 'Explain fit'}
          </button>
          <button className={btnGhost} onClick={() => run('portfolio')} disabled={loading !== null}>
            {loading === 'portfolio' ? 'Comparing…' : 'Compare vs portfolio'}
          </button>
        </span>
      </div>
      {error && <div className="mt-2"><ErrorNote message={error.message} hint={error.hint} /></div>}

      {explanation && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-xs leading-relaxed">
          <Badge demo={explanation.demo} cached={explanation.cached} />
          <p>{explanation.summary}</p>
          <div>
            <span className="font-semibold">Strengths:</span>
            <ul className="list-disc pl-4 text-slate-mid">{explanation.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
          {explanation.concerns.length > 0 && (
            <div>
              <span className="font-semibold">Concerns:</span>
              <ul className="list-disc pl-4 text-slate-mid">{explanation.concerns.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          <p><span className="font-semibold">Suggested next step:</span> {explanation.suggestedNextStep}</p>
        </div>
      )}

      {comparison && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-xs leading-relaxed">
          <Badge demo={comparison.demo} cached={comparison.cached} />
          <p>{comparison.summary}</p>
          {comparison.overlaps.length > 0 && (
            <div>
              <span className="font-semibold">Overlaps:</span>
              <ul className="list-disc pl-4 text-slate-mid">
                {comparison.overlaps.map((o, i) => <li key={i}><span className="font-medium text-ink">{o.portfolioCompany}</span> — {o.note}</li>)}
              </ul>
            </div>
          )}
          <p><span className="font-semibold">Whitespace:</span> {comparison.whitespace}</p>
          {comparison.sharedThemes.length > 0 && (
            <p><span className="font-semibold">Shared themes:</span> {comparison.sharedThemes.join(', ')}</p>
          )}
          {comparison.partnershipOpportunities.length > 0 && (
            <div>
              <span className="font-semibold">Partnership opportunities:</span>
              <ul className="list-disc pl-4 text-slate-mid">{comparison.partnershipOpportunities.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {comparison.concentrationRisk && <p><span className="font-semibold">Concentration risk:</span> {comparison.concentrationRisk}</p>}
          {comparison.themeExpansion && <p><span className="font-semibold">Theme expansion:</span> {comparison.themeExpansion}</p>}
          <p><span className="font-semibold">Confidence:</span> {comparison.confidence} (based only on the recorded portfolio data)</p>
          {comparison.evidenceNotes.length > 0 && (
            <div>
              <span className="font-semibold">Evidence:</span>
              <ul className="list-disc pl-4 text-slate-mid">{comparison.evidenceNotes.map((s, i) => <li key={i} className="break-all">{s}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Badge({ demo, cached }: { demo: boolean; cached: boolean }) {
  return (
    <div className="flex gap-1.5">
      <span className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${demo ? 'bg-marigold-soft text-marigold' : 'bg-verde-soft text-verde'}`}>
        {demo ? 'Local template — no AI model used' : 'AI-generated'}
      </span>
      {cached && <span className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-mid">cached</span>}
    </div>
  );
}
