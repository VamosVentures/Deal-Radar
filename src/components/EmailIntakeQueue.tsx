import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type EmailIntakeCandidate } from '../lib/api';
import { officialSubcategories, officialSubcategory, VERTICAL_OPTIONS } from '../data/taxonomy';
import { draftFor, firstEvidence, otherFounders, patchFrom, type Draft } from '../lib/emailIntakeDraft';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';

const STAGES = ['Pre-seed', 'Seed', 'Series A', 'Stealth', 'Unknown'] as const;

/**
 * The three fields approval requires (mirrors approvalBlockers in
 * server/services/emailIntake.ts), checked against the reviewer's
 * unsaved draft so Approve enables as soon as they're filled in —
 * Approve saves the draft first, so no separate Save is needed.
 */
function draftBlockers(d: Draft): string[] {
  const out: string[] = [];
  if (!d.name.trim()) out.push('name');
  if (!d.vertical) out.push('vertical');
  if (!d.evidenceDescription.trim()) out.push('evidence');
  return out;
}

/** Placeholder for optional inputs: blank is fine, it's recorded as Missing. */
const NOT_STATED = 'not in email';

const inputCls = 'w-full border border-line bg-paper px-1.5 py-1 text-[11px] placeholder:text-slate-mid/60';
const labelCls = 'block font-mono text-[9px] uppercase tracking-wider text-slate-mid';

function Field({ label, missing, children }: { label: string; missing: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}{missing && <span className="ml-1 text-alerta">missing</span>}</span>
      {children}
    </label>
  );
}

export function EmailIntakeQueue() {
  const [candidates, setCandidates] = useState<EmailIntakeCandidate[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.emailIntake.listCandidates().then((r) => {
      const pending = r.candidates.filter((c) => c.status === 'pending');
      setCandidates(pending);
      setDrafts((prev) => {
        const next: Record<number, Draft> = {};
        for (const c of pending) next[c.id] = prev[c.id] ?? draftFor(c);
        return next;
      });
    }).catch(() => { /* an empty queue is the normal case, not an error */ });
  }, []);
  useEffect(load, [load]);

  function updateDraft(id: number, field: string, value: string) {
    setDrafts((d) => {
      const next = { ...d[id], [field]: value };
      // A subcategory belongs to one vertical's taxonomy; changing the
      // vertical clears one that doesn't exist under the new vertical.
      if (field === 'vertical' && !officialSubcategory(value, next.subcategory)) next.subcategory = '';
      return { ...d, [id]: next };
    });
  }

  async function save(c: EmailIntakeCandidate) {
    setBusy(c.id);
    setError(null);
    try {
      await api.emailIntake.updateCandidate(c.id, patchFrom(drafts[c.id] ?? draftFor(c), c.extracted));
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function approve(c: EmailIntakeCandidate) {
    setBusy(c.id);
    setError(null);
    try {
      await save(c);
      await api.emailIntake.approveCandidate(c.id);
      setNotice(`Approved ${drafts[c.id]?.name || String(c.extracted.name ?? 'the company')}. Founder, stage and sector are being researched in the background — usually done within a minute or two; reload All Deals to see them.`);
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function discard(c: EmailIntakeCandidate) {
    setBusy(c.id);
    setError(null);
    try {
      await api.emailIntake.discardCandidate(c.id);
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  if (candidates.length === 0) {
    // Keep the "research started" note visible after the last approval empties the queue.
    return notice ? <p className="mt-4 text-[11px] text-slate-mid">{notice}</p> : null;
  }

  return (
    <section className="mt-8 border border-line bg-panel p-4" data-testid="email-intake-queue">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-ink">Email intake — review queue</h2>
        <span className="font-mono text-[10px] uppercase text-slate-mid">{candidates.length} pending</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        Companies Claude found in a forwarded email. Nothing here is a real company yet. To approve, each needs a
        name, a vertical, and who forwarded it — anything else left blank is recorded as Missing and can be filled
        in later. Approving starts background research for founder, stage and sector automatically (the same no-AI
        pass as &ldquo;Research now&rdquo;). Discard anything not worth pursuing.
      </p>
      {notice && <p className="mb-2 text-[11px] text-slate-mid">{notice}</p>}
      {error && <div className="mb-2"><ErrorNote message={error.message} issues={error.issues} /></div>}

      <ul className="space-y-4">
        {candidates.map((c) => {
          const d = drafts[c.id] ?? draftFor(c);
          const missing = new Set(draftBlockers(d));
          const disabled = busy === c.id;
          const claudeReason = typeof c.extracted.verticalReason === 'string' ? c.extracted.verticalReason : null;
          const fallbackReason = !c.extracted.vertical && typeof c.extracted.suggestedVerticalReason === 'string'
            ? c.extracted.suggestedVerticalReason : null;
          return (
            <li key={c.id} className="border-l-2 border-line pl-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="font-display text-sm font-bold text-ink">{d.name || '(unnamed)'}</span>
                {missing.size > 0 ? (
                  <span className="rounded-[2px] border border-alerta/40 bg-alerta-soft px-1.5 py-0.5 font-mono text-[9px] uppercase text-alerta">
                    {missing.size} required field{missing.size === 1 ? '' : 's'} missing
                  </span>
                ) : (
                  <span className="rounded-[2px] border border-verde/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-verde">
                    Ready to approve
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Field label="Name" missing={missing.has('name')}>
                  <input className={inputCls} disabled={disabled} value={d.name} onChange={(e) => updateDraft(c.id, 'name', e.target.value)} />
                </Field>
                <Field label="One-liner" missing={missing.has('oneLiner')}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.oneLiner} onChange={(e) => updateDraft(c.id, 'oneLiner', e.target.value)} />
                </Field>
                <Field label="Vertical" missing={missing.has('vertical')}>
                  <select className={inputCls} disabled={disabled} value={d.vertical} onChange={(e) => updateDraft(c.id, 'vertical', e.target.value)}>
                    <option value="">—</option>
                    {VERTICAL_OPTIONS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  {claudeReason && (
                    <p className="mt-0.5 text-[10px] text-marigold">Proposed by Claude — check it: {claudeReason}</p>
                  )}
                  {fallbackReason && (
                    <p className="mt-0.5 text-[10px] text-marigold">Suggested from the description — check it: {fallbackReason}</p>
                  )}
                </Field>
                <Field label="Subcategory" missing={missing.has('subcategory')}>
                  <select className={inputCls} disabled={disabled || !d.vertical} value={d.subcategory} onChange={(e) => updateDraft(c.id, 'subcategory', e.target.value)}>
                    <option value="">{d.vertical ? '—' : 'Pick a vertical first'}</option>
                    {officialSubcategories(d.vertical).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="Stage" missing={missing.has('stage')}>
                  <select className={inputCls} disabled={disabled} value={d.stage} onChange={(e) => updateDraft(c.id, 'stage', e.target.value)}>
                    <option value="">—</option>
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="City" missing={missing.has('city')}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.city} onChange={(e) => updateDraft(c.id, 'city', e.target.value)} />
                </Field>
                <Field label="State" missing={missing.has('state')}>
                  <input className={inputCls} disabled={disabled} maxLength={2} placeholder={NOT_STATED} value={d.state} onChange={(e) => updateDraft(c.id, 'state', e.target.value)} />
                </Field>
                <Field label="Website" missing={false}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.website} onChange={(e) => updateDraft(c.id, 'website', e.target.value)} />
                </Field>
                <Field label="Founded year" missing={missing.has('foundedYear')}>
                  <input className={inputCls} disabled={disabled} type="number" placeholder={NOT_STATED} value={d.foundedYear} onChange={(e) => updateDraft(c.id, 'foundedYear', e.target.value)} />
                </Field>
                <Field label="Team size" missing={missing.has('teamSize')}>
                  <input className={inputCls} disabled={disabled} type="number" placeholder={NOT_STATED} value={d.teamSize} onChange={(e) => updateDraft(c.id, 'teamSize', e.target.value)} />
                </Field>
                <Field label="Traction (0-10)" missing={missing.has('traction')}>
                  <input className={inputCls} disabled={disabled} type="number" min={0} max={10} placeholder={NOT_STATED} value={d.tractionLevel} onChange={(e) => updateDraft(c.id, 'tractionLevel', e.target.value)} />
                </Field>
                <Field label="Traction note" missing={missing.has('traction')}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.tractionNote} onChange={(e) => updateDraft(c.id, 'tractionNote', e.target.value)} />
                </Field>
                <Field label="Founder name" missing={missing.has('founders')}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.founderName} onChange={(e) => updateDraft(c.id, 'founderName', e.target.value)} />
                  {otherFounders(c.extracted).length > 0 && (
                    <p className="mt-0.5 text-[10px] text-slate-mid">
                      Also from the email (kept on approve): {otherFounders(c.extracted).map((f) => String(f.name ?? '')).filter(Boolean).join(', ')}
                    </p>
                  )}
                </Field>
                <Field label="Founder role" missing={false}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.founderRole} onChange={(e) => updateDraft(c.id, 'founderRole', e.target.value)} />
                </Field>
                <Field label="Founder background" missing={false}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.founderBackground} onChange={(e) => updateDraft(c.id, 'founderBackground', e.target.value)} />
                </Field>
                <Field label="Raising" missing={false}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.raising} onChange={(e) => updateDraft(c.id, 'raising', e.target.value)} />
                </Field>
                <Field label="Accelerator" missing={false}>
                  <input className={inputCls} disabled={disabled} placeholder={NOT_STATED} value={d.accelerator} onChange={(e) => updateDraft(c.id, 'accelerator', e.target.value)} />
                </Field>
              </div>

              <div className="mt-2 border-t border-line pt-2">
                <p className="text-[11px] leading-relaxed text-ink">
                  Evidence (from the email): {firstEvidence(c.extracted).claim
                    ? <span>&ldquo;{firstEvidence(c.extracted).claim}&rdquo;</span>
                    : <span className="text-slate-mid">no excerpt reported</span>}
                </p>
                <Field label="Who forwarded this, and when" missing={missing.has('evidence')}>
                  <input
                    className={inputCls} disabled={disabled} value={d.evidenceDescription}
                    placeholder="e.g. Forwarded by Jane Doe, 2026-09-14"
                    onChange={(e) => updateDraft(c.id, 'evidenceDescription', e.target.value)}
                  />
                </Field>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={btnGhost} disabled={disabled} onClick={() => void save(c)}>Save changes</button>
                <button
                  type="button" className={btnPrimary} disabled={disabled || missing.size > 0}
                  title={missing.size > 0 ? 'Fill in the name, vertical, and who forwarded it first' : 'Saves your edits and creates the company'}
                  onClick={() => void approve(c)}
                >
                  Approve
                </button>
                <button type="button" className={btnGhost} disabled={disabled} onClick={() => void discard(c)}>Discard</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
