import { useState } from 'react';
import { api } from '../lib/api';
import {
  PRIMARY_SECTORS, RESOLUTION_STATE_LABELS, SECTOR_LABELS, STAGE_LABELS, STAGE_RESULTS,
  NON_SECTOR_STATUS,
  type CompanyEnrichment, type EnrichedField, type ResolutionState,
} from '../../shared/enrichment';

/**
 * Rendering an enriched field.
 *
 * Every component here treats retrieved content as UNTRUSTED PLAIN TEXT.
 * There is no dangerouslySetInnerHTML anywhere in this file and there
 * must never be: founder names, titles, supporting quotes, and
 * classification reasons all originate from third-party pages we do not
 * control, and React's default escaping is the thing standing between a
 * scraped page and the DOM.
 *
 * The rendering rule that matters: a value is shown as a FACT only in
 * the `confirmed` state. Inference is labelled, a candidate is labelled
 * and never promoted to the headline, a conflict shows both sides, and
 * an exhausted search shows what was searched. No branch falls back to
 * the word "Unknown".
 */

const STATE_STYLES: Record<ResolutionState, string> = {
  confirmed: 'border-verde/30 bg-verde-soft text-verde',
  'bounded-inference': 'border-marigold/40 bg-marigold/10 text-ink',
  candidate: 'border-line bg-canvas text-slate-mid',
  conflict: 'border-alerta/40 bg-alerta/10 text-alerta',
  'research-exhausted': 'border-line bg-canvas text-slate-mid',
  'manual-review': 'border-line bg-canvas text-slate-mid',
};

export function ResolutionBadge({ state, inferred, confidence }: { state: ResolutionState; inferred?: boolean; confidence?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${STATE_STYLES[state]}`}
      title={`Resolution state: ${RESOLUTION_STATE_LABELS[state]}${typeof confidence === 'number' ? ` · confidence ${(confidence * 100).toFixed(0)}%` : ''}`}
    >
      {RESOLUTION_STATE_LABELS[state]}
      {/* Inference is labelled on the badge itself, not only in a tooltip —
          a reader scanning a column must be able to see it without hovering. */}
      {inferred && <span className="opacity-70">· inferred</span>}
    </span>
  );
}

function EvidenceLinks({ evidence }: { evidence: EnrichedField<unknown>['evidence'] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {evidence.slice(0, 6).map((e, i) => (
        <li key={`${e.url}-${i}`} className="truncate text-[11px]">
          <a
            href={e.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-mid underline decoration-dotted underline-offset-2 hover:text-ink"
            title={e.url}
          >
            {e.label}
          </a>
          {e.publishedAt && <span className="ml-1 font-mono text-[10px] text-slate-mid">· {e.publishedAt}</span>}
        </li>
      ))}
    </ul>
  );
}

// ── Compact cells for the company table ──────────────────────────

/**
 * The founder cell.
 *
 * Replaces "Unknown founder". A verified founder shows the name and
 * title; a candidate shows the candidate explicitly marked unconfirmed;
 * a conflict says so; an exhausted search says when it completed. None
 * of these is a blank.
 */
export function FounderCell({ enrichment }: { enrichment: CompanyEnrichment | undefined }) {
  if (!enrichment) {
    return <span className="text-xs italic text-slate-mid">Not yet researched</span>;
  }
  const f = enrichment.founder;
  if (f.value) {
    return (
      <span className="text-sm">
        <span className="font-semibold text-ink">{f.value.name}</span>
        {f.value.title && <span className="text-slate-mid"> · {f.value.title}</span>}
      </span>
    );
  }
  const top = f.candidates.find((c) => c.reviewDecision !== 'rejected');
  return (
    <span className="flex flex-col gap-0.5">
      <ResolutionBadge state={f.state} confidence={f.confidence} />
      {top && (
        <span className="text-xs text-slate-mid" title={top.supportingText}>
          {/* Rendered as a candidate, never as the answer. */}
          Candidate: {top.fullName}{top.title ? ` (${top.title})` : ''}
        </span>
      )}
    </span>
  );
}

export function VerticalCell({ enrichment }: { enrichment: CompanyEnrichment | undefined }) {
  if (!enrichment?.vertical.value) {
    return <span className="text-xs italic text-slate-mid">Not yet classified</span>;
  }
  const v = enrichment.vertical;
  return (
    <span className="flex flex-col gap-0.5" title={v.summary}>
      <span className="text-sm font-semibold text-ink">{v.value!.primaryLabel}</span>
      {v.value!.subvertical && <span className="text-[11px] text-slate-mid">{v.value!.subvertical}</span>}
      {v.inferred && <ResolutionBadge state={v.state} inferred confidence={v.confidence} />}
    </span>
  );
}

export function StageCell({ enrichment }: { enrichment: CompanyEnrichment | undefined }) {
  if (!enrichment?.stage.value) {
    return <span className="text-xs italic text-slate-mid">Not yet researched</span>;
  }
  const s = enrichment.stage;
  return (
    <span className="flex flex-col gap-0.5" title={s.summary}>
      <span className="text-sm text-ink">{s.value!.label}</span>
      {(s.inferred || s.state === 'conflict') && (
        <ResolutionBadge state={s.state} inferred={s.inferred} confidence={s.confidence} />
      )}
    </span>
  );
}

// ── Full detail panel ─────────────────────────────────────────────

function FieldBlock({
  title, field, children,
}: { title: string; field: EnrichedField<unknown>; children?: React.ReactNode }) {
  return (
    <section className="border border-line bg-white p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h4 className="font-mono text-[11px] uppercase tracking-widest text-slate-mid">{title}</h4>
        <ResolutionBadge state={field.state} inferred={field.inferred} confidence={field.confidence} />
        {field.lastResearchedAt && (
          <span className="font-mono text-[10px] text-slate-mid">
            researched {field.lastResearchedAt.slice(0, 10)}
          </span>
        )}
      </div>
      {children}
      <p className="text-xs leading-relaxed text-ink">{field.summary}</p>
      {field.conflicts.length > 0 && (
        <div className="mt-2 border-l-2 border-alerta/50 pl-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alerta">Conflicting sources</p>
          <ul className="mt-0.5 space-y-0.5">
            {field.conflicts.map((c, i) => (
              <li key={i} className="text-[11px] text-slate-mid">
                {c.detail}{' '}
                <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <EvidenceLinks evidence={field.evidence} />
      <p className="mt-2 border-t border-line pt-1.5 text-[11px] text-slate-mid">
        <span className="font-mono uppercase tracking-widest">Next</span> · {field.nextAction}
      </p>
      {field.sourcesAttempted.length > 0 && (
        <p className="mt-1 text-[10px] text-slate-mid">
          Sources attempted: {field.sourcesAttempted.join(', ')}
        </p>
      )}
    </section>
  );
}

export function EnrichmentPanel({
  companyId, enrichment, onChanged,
}: {
  companyId: string;
  enrichment: CompanyEnrichment | undefined;
  onChanged?: (next: CompanyEnrichment) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<'founder' | 'vertical' | 'stage' | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  const research = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.enrichment.research(companyId);
      onChanged?.(r.enrichment);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCorrection = async () => {
    if (!correcting) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.enrichment.correct(
        companyId, correcting, value.trim(), reason.trim(), sourceUrl.trim() || null,
      );
      onChanged?.(r.enrichment);
      setCorrecting(null);
      setValue('');
      setReason('');
      setSourceUrl('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!enrichment) {
    return (
      <div className="border border-line bg-canvas p-3">
        <p className="text-xs text-slate-mid">
          This company has not been through founder, sector, or stage research yet. Nothing is known
          either way — this is an absence of research, not an absence of facts.
        </p>
        <button
          onClick={research}
          disabled={busy}
          className="mt-2 rounded-[2px] bg-ink px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Researching…' : 'Research now'}
        </button>
        {error && <p className="mt-2 text-xs text-alerta">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={research}
          disabled={busy}
          className="rounded-[2px] bg-ink px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          title="Re-runs every applicable public source family for this company. Writes are idempotent — pressing this twice refreshes rather than duplicates."
        >
          {busy ? 'Researching…' : 'Research again'}
        </button>
        {(['founder', 'vertical', 'stage'] as const).map((f) => (
          <button
            key={f}
            onClick={() => { setCorrecting(f); setValue(''); setReason(''); setSourceUrl(''); }}
            data-testid={`correct-${f}`}
            className="rounded-[2px] border border-line px-2 py-1 text-[11px] text-slate-mid hover:text-ink"
          >
            Correct {f}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-alerta">{error}</p>}

      {correcting && (
        <div className="border border-marigold/50 bg-marigold/5 p-3">
          <p className="mb-2 text-[11px] text-slate-mid">
            Your correction is recorded alongside the automated research, which is preserved. Your name,
            the time, the previous value, and your reason are stored with it.
          </p>
          {correcting === 'vertical' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)} data-testid="correction-value" className="mb-2 w-full border border-line px-2 py-1 text-sm">
              <option value="">Select a sector…</option>
              {PRIMARY_SECTORS.map((s) => <option key={s} value={s}>{SECTOR_LABELS[s]}</option>)}
              <option value={NON_SECTOR_STATUS}>Not classifiable — identity unresolved</option>
            </select>
          ) : correcting === 'stage' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)} data-testid="correction-value" className="mb-2 w-full border border-line px-2 py-1 text-sm">
              <option value="">Select a stage…</option>
              {STAGE_RESULTS.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
          ) : (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Founder name"
              data-testid="correction-value"
              className="mb-2 w-full border border-line px-2 py-1 text-sm"
            />
          )}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? (required — this is the audit trail)"
            rows={2}
            data-testid="correction-reason"
            className="mb-2 w-full border border-line px-2 py-1 text-sm"
          />
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="Source URL (optional but strongly preferred)"
            className="mb-2 w-full border border-line px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={submitCorrection}
              disabled={busy || value.trim().length === 0 || reason.trim().length < 3}
              data-testid="correction-save"
              className="rounded-[2px] bg-ink px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Save correction
            </button>
            <button onClick={() => setCorrecting(null)} className="px-3 py-1.5 text-xs text-slate-mid">Cancel</button>
          </div>
        </div>
      )}

      <FieldBlock title="Founder" field={enrichment.founder}>
        {enrichment.founder.value && (
          <p className="mb-1 text-sm">
            <span className="font-semibold text-ink">{enrichment.founder.value.name}</span>
            {enrichment.founder.value.title && <span className="text-slate-mid"> · {enrichment.founder.value.title}</span>}
          </p>
        )}
        {enrichment.founder.candidates.length > 0 && (
          <div className="mb-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
              Candidates ({enrichment.founder.candidates.length}) — evidence for each
            </p>
            <ul className="mt-0.5 space-y-1">
              {enrichment.founder.candidates.slice(0, 8).map((c) => (
                <li key={c.id} className="border-l-2 border-line pl-2 text-[11px]">
                  <span className="font-semibold text-ink">{c.fullName}</span>
                  {c.title && <span className="text-slate-mid"> — {c.title}</span>}
                  {c.reviewDecision && (
                    <span className={`ml-1 font-mono text-[10px] ${c.reviewDecision === 'confirmed' ? 'text-verde' : 'text-alerta'}`}>
                      [{c.reviewDecision} by {c.reviewedBy}]
                    </span>
                  )}
                  <div className="text-slate-mid">
                    {c.sourceType} ·{' '}
                    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
                    {' '}· match {c.matchScore} · confidence {(c.confidence * 100).toFixed(0)}%
                  </div>
                  {/* Supporting text is scraped third-party content. Rendered as text, never as markup. */}
                  <div className="italic text-slate-mid">“{c.supportingText}”</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </FieldBlock>

      <FieldBlock title="Vertical" field={enrichment.vertical}>
        {enrichment.vertical.value && (
          <p className="mb-1 text-sm">
            <span className="font-semibold text-ink">{enrichment.vertical.value.primaryLabel}</span>
            {enrichment.vertical.value.secondarySector && (
              <span className="text-slate-mid"> · secondary: {enrichment.vertical.value.secondarySector}</span>
            )}
            {enrichment.vertical.value.subvertical && (
              <span className="text-slate-mid"> · {enrichment.vertical.value.subvertical}</span>
            )}
          </p>
        )}
        {enrichment.vertical.value?.evidenceGap && (
          <p className="mb-1 border-l-2 border-alerta/40 pl-2 text-[11px] text-slate-mid">
            Evidence gap: {enrichment.vertical.value.evidenceGap}
          </p>
        )}
        {enrichment.vertical.value && !enrichment.vertical.value.countsTowardRanking && (
          <p className="mb-1 text-[11px] font-semibold text-alerta">
            Excluded from sector rankings and shortlists.
          </p>
        )}
      </FieldBlock>

      <FieldBlock title="Stage" field={enrichment.stage}>
        {enrichment.stage.value && (
          <p className="mb-1 text-sm font-semibold text-ink">{enrichment.stage.value.label}</p>
        )}
      </FieldBlock>

      {enrichment.attempts.length > 0 && (
        <details className="border border-line bg-white p-3">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-slate-mid">
            Research record ({enrichment.attempts.length} source families attempted)
          </summary>
          <ul className="mt-2 space-y-1">
            {enrichment.attempts.map((a) => (
              <li key={a.sourceFamily} className="text-[11px]">
                <span className="font-mono text-slate-mid">{a.sourceFamily}</span>{' '}
                <span className="font-semibold text-ink">{a.outcome}</span>{' '}
                <span className="text-slate-mid">· {a.attemptedAt.slice(0, 10)}</span>
                <div className="text-slate-mid">{a.detail}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {enrichment.corrections.length > 0 && (
        <details className="border border-line bg-white p-3">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-slate-mid">
            Reviewer corrections ({enrichment.corrections.length}) — automated evidence preserved
          </summary>
          <ul className="mt-2 space-y-1">
            {enrichment.corrections.map((c) => (
              <li key={c.id} className="text-[11px]">
                <span className="font-mono uppercase text-slate-mid">{c.field}</span>{' '}
                <span className="text-slate-mid">{c.previousValue ?? '(none)'} → </span>
                <span className="font-semibold text-ink">{c.newValue}</span>
                <div className="text-slate-mid">
                  {c.reviewerLabel} · {c.at.slice(0, 10)} · {c.reason}
                  {c.sourceUrl && (
                    <>
                      {' '}
                      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
