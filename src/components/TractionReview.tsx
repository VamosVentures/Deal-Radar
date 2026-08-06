import { useEffect, useState } from 'react';
import {
  TRACTION_EVIDENCE_TYPES, TRACTION_STATE_SPECS, TRACTION_STATES,
  TRACTION_VERIFICATION_LABELS, TRACTION_VERIFICATIONS,
  validateTractionReview,
  type TractionEvidenceType, type TractionState, type TractionVerification,
} from '../../shared/traction';
import { api } from '../lib/api';
import { btnPrimary } from './Modal';

/**
 * Analyst traction review, inside the existing company-detail panel.
 *
 * Traction is 10 of the model's 100 points and one of the five
 * components the provisional policy requires, and it was unassessable
 * for every company on file because nothing in the product let a person
 * record what they had found. This is that step.
 *
 * The two things the UI itself has to get right:
 *
 *  - The two NON-SCORING states are labelled as such on screen, so an
 *    analyst choosing "No publicly disclosed traction" knows they are
 *    recording a real finding that is deliberately excluded from the
 *    score rather than a zero.
 *  - The actor field is a plain string and is described that way. This
 *    build has one shared password; presenting the name as a verified
 *    identity would be a lie the UI told on the backend's behalf.
 */

interface HistoryEntry {
  id: number;
  state: TractionState;
  previousState: TractionState | null;
  verification: TractionVerification;
  customerName: string | null;
  metricValue: string | null;
  sourceUrl: string | null;
  analystNote: string | null;
  evidenceDate: string | null;
  confidence: string;
  missingDiligence: string | null;
  actor: string;
  at: string;
}

export function TractionReview({ companyId, onSaved }: { companyId: string; onSaved?: () => void }) {
  const [state, setState] = useState<TractionState>('unknown');
  const [current, setCurrent] = useState<TractionState>('unknown');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [evidenceType, setEvidenceType] = useState<TractionEvidenceType>('company-website');
  const [verification, setVerification] = useState<TractionVerification>('company-claimed');
  const [customerName, setCustomerName] = useState('');
  const [metricValue, setMetricValue] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [analystNote, setAnalystNote] = useState('');
  const [evidenceDate, setEvidenceDate] = useState('');
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('medium');
  const [missingDiligence, setMissingDiligence] = useState('');
  const [actor, setActor] = useState('team');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.imports.tractionReview(companyId).then((r) => {
      if (!live) return;
      setCurrent(r.state);
      setState(r.state);
      setHistory(r.history as unknown as HistoryEntry[]);
    }).catch(() => { /* absence of history is not an error worth shouting about */ });
    return () => { live = false; };
  }, [companyId]);

  const spec = TRACTION_STATE_SPECS[state];

  // Mirror the server's rule locally so the analyst sees the problem
  // before submitting. The server re-checks it regardless — this is a
  // convenience, never the enforcement point.
  const localCheck = validateTractionReview({
    companyId, state, evidenceType, verification,
    customerName: customerName || null,
    metricValue: metricValue || null,
    sourceUrl: sourceUrl || null,
    analystNote: analystNote || null,
    evidenceDate: evidenceDate || null,
    confidence,
    missingDiligence: missingDiligence || null,
    actor,
  });

  async function submit() {
    setSaving(true);
    setErrors([]);
    setSaved(null);
    try {
      const res = await api.imports.saveTractionReview(companyId, {
        state, evidenceType, verification,
        customerName: customerName || null,
        metricValue: metricValue || null,
        sourceUrl: sourceUrl || null,
        analystNote: analystNote || null,
        evidenceDate: evidenceDate || null,
        confidence,
        missingDiligence: missingDiligence || null,
        actor,
      });
      setCurrent(state);
      setSaved(
        res.score
          ? `Saved. Score ${res.score.before?.toFixed(1) ?? '—'} → ${res.score.after.toFixed(1)}`
            + `${res.score.provisionalAfter ? ' (still provisional)' : ' (now fully assessed)'}`
            + `${res.scoreRowAppended ? ' — new scoring row appended.' : ' — score unchanged.'}`
          : 'Saved.',
      );
      const refreshed = await api.imports.tractionReview(companyId);
      setHistory(refreshed.history as unknown as HistoryEntry[]);
      onSaved?.();
    } catch (e) {
      const msgs = (e as { messages?: string[] }).messages;
      setErrors(msgs && msgs.length > 0 ? msgs : [(e as Error).message]);
    } finally {
      setSaving(false);
    }
  }

  const field = 'w-full border border-line bg-paper px-2 py-1 text-sm';
  const label = 'mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-slate-mid';

  return (
    <section className="border border-line bg-panel p-4" data-testid="traction-review">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-bold text-ink">Traction review</h3>
        <span className="font-mono text-[10px] uppercase text-slate-mid">
          current: {TRACTION_STATE_SPECS[current].label}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        Traction is 10 of the model’s 100 points and one of the five components a score needs to stop
        being provisional. Record what you found — including finding nothing.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="traction-state">Traction status</label>
          <select
            id="traction-state" data-testid="traction-state" className={field}
            value={state} onChange={(e) => setState(e.target.value as TractionState)}
          >
            {TRACTION_STATES.map((s) => (
              <option key={s} value={s}>
                {TRACTION_STATE_SPECS[s].label}
                {TRACTION_STATE_SPECS[s].scores ? ` — scores ${TRACTION_STATE_SPECS[s].level}/10` : ' — not scored'}
              </option>
            ))}
          </select>
          <p className={`mt-1 text-[11px] leading-relaxed ${spec.scores ? 'text-slate-mid' : 'text-marigold'}`}>
            {spec.description}
          </p>
        </div>

        <div>
          <label className={label} htmlFor="traction-evidence-type">Evidence type</label>
          <select id="traction-evidence-type" className={field} value={evidenceType} onChange={(e) => setEvidenceType(e.target.value as TractionEvidenceType)}>
            {TRACTION_EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="traction-verification">Independently confirmed?</label>
          <select id="traction-verification" data-testid="traction-verification" className={field} value={verification} onChange={(e) => setVerification(e.target.value as TractionVerification)}>
            {TRACTION_VERIFICATIONS.map((v) => <option key={v} value={v}>{TRACTION_VERIFICATION_LABELS[v]}</option>)}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="traction-customer">Customer / pilot / deployment</label>
          <input id="traction-customer" className={field} value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Only if publishable" />
        </div>

        <div>
          <label className={label} htmlFor="traction-metric">Revenue / usage figure</label>
          <input id="traction-metric" className={field} value={metricValue} onChange={(e) => setMetricValue(e.target.value)} placeholder="Verbatim; needs a source URL" />
        </div>

        <div className="sm:col-span-2">
          <label className={label} htmlFor="traction-source">Source URL</label>
          <input id="traction-source" data-testid="traction-source" className={field} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
        </div>

        <div className="sm:col-span-2">
          <label className={label} htmlFor="traction-note">Analyst note</label>
          <textarea id="traction-note" data-testid="traction-note" className={field} rows={3} value={analystNote} onChange={(e) => setAnalystNote(e.target.value)} placeholder="What you found and where. Required if there is no source URL." />
        </div>

        <div>
          <label className={label} htmlFor="traction-date">Evidence date</label>
          <input id="traction-date" type="date" className={field} value={evidenceDate} onChange={(e) => setEvidenceDate(e.target.value)} />
        </div>

        <div>
          <label className={label} htmlFor="traction-confidence">Confidence</label>
          <select id="traction-confidence" className={field} value={confidence} onChange={(e) => setConfidence(e.target.value as 'low' | 'medium' | 'high')}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className={label} htmlFor="traction-missing">Missing diligence question</label>
          <input id="traction-missing" className={field} value={missingDiligence} onChange={(e) => setMissingDiligence(e.target.value)} placeholder="What would settle this?" />
        </div>

        <div className="sm:col-span-2">
          <label className={label} htmlFor="traction-actor">Recorded by</label>
          <input id="traction-actor" className={field} value={actor} onChange={(e) => setActor(e.target.value)} />
          <p className="mt-0.5 text-[10px] text-slate-mid">
            A plain label for the audit trail. This build uses one shared password, so this is not a
            verified identity and is never presented as one.
          </p>
        </div>
      </div>

      {!localCheck.ok && (
        <ul className="mt-3 space-y-1 border-l-2 border-marigold pl-2 text-[11px] text-marigold">
          {localCheck.errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {errors.length > 0 && (
        <ul className="mt-3 space-y-1 border-l-2 border-alerta pl-2 text-[11px] text-alerta" data-testid="traction-errors">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {saved && <p className="mt-3 text-[11px] text-verde" data-testid="traction-saved">{saved}</p>}

      <button
        type="button" className={`${btnPrimary} mt-3`} data-testid="traction-save"
        disabled={saving || !localCheck.ok} onClick={() => void submit()}
      >
        {saving ? 'Recording…' : 'Record traction review'}
      </button>

      {history.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-mid">
            Review history ({history.length}) — append-only
          </h4>
          <ul className="space-y-2" data-testid="traction-history">
            {history.map((h) => (
              <li key={h.id} className="text-[11px] leading-relaxed text-slate-mid">
                <span className="text-ink">
                  {h.previousState ? `${TRACTION_STATE_SPECS[h.previousState].label} → ` : ''}
                  {TRACTION_STATE_SPECS[h.state].label}
                </span>
                {' · '}{TRACTION_VERIFICATION_LABELS[h.verification]}
                {' · '}confidence {h.confidence}
                {h.customerName && <> · {h.customerName}</>}
                {h.metricValue && <> · {h.metricValue}</>}
                {h.sourceUrl && <> · <a className="underline" href={h.sourceUrl} target="_blank" rel="noreferrer">source</a></>}
                {' · '}<span className="font-mono text-[10px]">{h.at.slice(0, 10)} by {h.actor}</span>
                {h.analystNote && <div className="mt-0.5 italic">{h.analystNote}</div>}
                {h.missingDiligence && <div className="mt-0.5">Open question: {h.missingDiligence}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
