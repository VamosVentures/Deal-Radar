import { useCallback, useEffect, useState } from 'react';
import { api, type PendingEvidenceItem } from '../lib/api';
import { TRACTION_STATE_SPECS, type TractionState } from '../../shared/traction';

/**
 * Extractor findings awaiting a human ruling.
 *
 * The rule this surface exists to hold: reading a claim is not believing
 * it. The YC parser can pull "20 departments across 16 hospitals" off a
 * public page — cited, verbatim, dated. It is still the company
 * describing itself, and nothing here scores it.
 *
 * Accepting a claim marks the CLAIM reviewed. It does not set a traction
 * rating: that is a separate submission in the panel below, with its own
 * evidence requirement. Two steps on purpose — agreeing that a company
 * said something is not the same as deciding what it is worth.
 *
 * Leaving an item alone is a valid outcome. Nothing here nags, defaults,
 * or auto-resolves.
 */

const STATUS_STYLE: Record<PendingEvidenceItem['status'], string> = {
  pending: 'border-marigold/40 bg-marigold-soft text-marigold',
  accepted: 'border-verde/30 bg-verde-soft text-verde',
  rejected: 'border-line bg-paper text-slate-mid',
  edited: 'border-line bg-paper text-ink',
};

export function PendingEvidencePanel({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<PendingEvidenceItem[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** Which row's excerpt editor is open, and the in-progress text per row. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    void api.imports.pendingEvidence(companyId)
      .then((r) => setItems(r.items))
      .catch(() => { /* no pending evidence is the normal case, not an error */ });
  }, [companyId]);

  useEffect(load, [load]);

  async function decide(id: number, status: 'accepted' | 'rejected' | 'edited', editedQuote?: string) {
    setBusy(id);
    setError(null);
    try {
      await api.imports.decidePendingEvidence(id, {
        status, actor: 'team', note: note[id] || null,
        editedQuote: status === 'edited' ? (editedQuote ?? null) : null,
      });
      setEditing(null);
      load();
    } catch (e) {
      // Surfaced, not swallowed: a 409 means a colleague already ruled on
      // this item, and the reviewer needs to know that rather than see
      // their click quietly do nothing.
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;

  const pending = items.filter((i) => i.status === 'pending');
  const btn = 'border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider hover:bg-paper disabled:opacity-40';

  return (
    <section className="mb-4 border border-line bg-panel p-4" data-testid="pending-evidence">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-bold text-ink">Extracted claims awaiting your decision</h3>
        <span className="font-mono text-[10px] uppercase text-slate-mid">
          {pending.length} pending of {items.length}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        Found by the extractor on a public page and quoted verbatim. Everything here is
        <strong className="text-ink"> company-claimed</strong> unless a third party is cited — an accelerator
        publishing a company’s own words is not independent confirmation. <strong className="text-ink">None of
        it affects any score.</strong> Accepting a claim records that you agree the company said it; rating
        the traction is the separate step below.
      </p>

      {error && <p className="mb-2 text-[11px] text-alerta">{error}</p>}

      <ul className="space-y-3">
        {items.map((i) => {
          const suggested = i.suggestedState && i.kind === 'traction'
            ? TRACTION_STATE_SPECS[i.suggestedState as TractionState]?.label
            : i.suggestedState;
          return (
            <li key={i.id} className="border-l-2 border-line pl-3">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded-[2px] border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-slate-mid">
                  {i.kind}
                </span>
                <span className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] uppercase ${STATUS_STYLE[i.status]}`}>
                  {i.status}
                </span>
                <span className="rounded-[2px] border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-slate-mid">
                  {i.provenance}
                </span>
                <span className="font-mono text-[9px] uppercase text-slate-mid">{i.section}</span>
              </div>

              <blockquote className="text-[12px] leading-relaxed text-ink">“{i.quote}”</blockquote>

              <div className="mt-1 font-mono text-[10px] text-slate-mid">
                <a className="underline" href={i.sourceUrl} target="_blank" rel="noreferrer">source</a>
                {' · '}accessed {i.accessedAt}
              </div>

              {suggested && (
                <p className="mt-1 text-[11px] text-marigold">
                  Suggested: <strong>{suggested}</strong> — not applied.
                  {i.suggestionBasis && <span className="text-slate-mid"> {i.suggestionBasis}</span>}
                </p>
              )}

              {i.status === 'pending' ? (
                <div className="mt-2 space-y-2">
                  {/*
                    "Edit" now edits.
                    It used to POST status:'edited' and nothing else — the
                    quote, section and suggestion were all immutable, so the
                    control announced a capability it did not have. Opening
                    the editor prefills the published sentence; saving stores
                    the correction in `edited_quote` and leaves `quote`
                    untouched, so the original claim stays auditable.
                  */}
                  {editing === i.id && (
                    <div>
                      <label className="block font-mono text-[9px] uppercase tracking-wider text-slate-mid" htmlFor={`edit-${i.id}`}>
                        Corrected excerpt — the published quote above is kept unchanged
                      </label>
                      <textarea
                        id={`edit-${i.id}`}
                        data-testid={`pending-edit-input-${i.id}`}
                        rows={3}
                        className="mt-1 w-full border border-marigold bg-paper px-2 py-1 text-[12px]"
                        value={draft[i.id] ?? i.quote}
                        onChange={(e) => setDraft((d) => ({ ...d, [i.id]: e.target.value }))}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="min-w-[12rem] flex-1 border border-line bg-paper px-2 py-1 text-[11px]"
                      placeholder="Optional note — what you concluded and why"
                      value={note[i.id] ?? ''}
                      onChange={(e) => setNote((n) => ({ ...n, [i.id]: e.target.value }))}
                    />
                    <button type="button" className={btn} disabled={busy === i.id}
                      data-testid={`pending-accept-${i.id}`} onClick={() => void decide(i.id, 'accepted')}>
                      Accept
                    </button>
                    {editing === i.id ? (
                      <button type="button" className={btn} disabled={busy === i.id}
                        data-testid={`pending-save-edit-${i.id}`}
                        onClick={() => void decide(i.id, 'edited', (draft[i.id] ?? i.quote))}>
                        Save edit
                      </button>
                    ) : (
                      <button type="button" className={btn} disabled={busy === i.id}
                        data-testid={`pending-edit-${i.id}`}
                        onClick={() => { setEditing(i.id); setDraft((d) => ({ ...d, [i.id]: d[i.id] ?? i.quote })); }}>
                        Edit
                      </button>
                    )}
                    <button type="button" className={btn} disabled={busy === i.id}
                      data-testid={`pending-reject-${i.id}`} onClick={() => void decide(i.id, 'rejected')}>
                      Reject
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1 space-y-1">
                  {i.editedQuote && (
                    <p className="border-l-2 border-marigold pl-2 text-[12px] leading-relaxed text-ink">
                      <span className="font-mono text-[9px] uppercase tracking-wider text-marigold">edited to</span>{' '}
                      “{i.editedQuote}”
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-slate-mid">
                    {i.status} by {i.decidedBy ?? 'unknown'}
                    {i.decisionNote ? ` — ${i.decisionNote}` : ''}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
