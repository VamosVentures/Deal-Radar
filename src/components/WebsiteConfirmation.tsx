import { useState } from 'react';
import { api, ApiError, type WebsiteConfirmationPreview, type WebsiteConfirmationResult } from '../lib/api';
import { btnGhost, btnPrimary } from './Modal';
import { OPPORTUNITY_CLASS_LABELS } from '../../shared/opportunity';
import { QUALIFICATION_LABELS } from '../../shared/qualification';

/**
 * Confirming an official website by hand, with evidence.
 *
 * Deliberately two steps. Step one asks for the site AND the source that
 * establishes it, then shows exactly what is on record now against what
 * would replace it. Step two is the confirmation. Nothing is written
 * until a person has seen the diff and pressed the second button — the
 * server enforces that too, so this is the honest surface of a real
 * rule, not a UI courtesy.
 *
 * This exists because the automatic discoverer refuses to derive a
 * domain from a common single-word name and should keep refusing: a page
 * containing the word "natural" is not evidence about a company called
 * Natural. A human reading an official announcement is different
 * evidence, and this is where that evidence gets recorded.
 */

const input = 'w-full border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-slate-mid focus:border-marigold focus:outline-none';
const label = 'font-mono text-[10px] uppercase tracking-widest text-slate-mid';

function Row({ name, before, after }: { name: string; before: string; after: string }) {
  const changed = before !== after;
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 py-1">
      <span className={label}>{name}</span>
      <div className="min-w-0">
        <div className="break-all font-mono text-[11px] text-slate-mid line-through decoration-slate-mid/50">{before}</div>
        <div className={`break-all font-mono text-[11px] ${changed ? 'text-verde' : 'text-slate-mid'}`}>{after}</div>
      </div>
    </div>
  );
}

export function WebsiteConfirmationPanel({ companyId, companyName, currentWebsite, onDone }: {
  companyId: string;
  companyName: string;
  currentWebsite: string | null;
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [website, setWebsite] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<WebsiteConfirmationPreview | null>(null);
  const [result, setResult] = useState<WebsiteConfirmationResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const payload = { website: website.trim(), evidenceUrl: evidenceUrl.trim(), reason: reason.trim(), actor: 'team' };
  const complete = payload.website.length > 0 && payload.evidenceUrl.length > 0 && payload.reason.length >= 10;

  const reset = () => {
    setWebsite(''); setEvidenceUrl(''); setReason('');
    setPreview(null); setResult(null); setError(null);
  };

  const runPreview = async () => {
    setBusy('preview'); setError(null); setResult(null);
    try {
      setPreview(await api.imports.previewWebsiteConfirmation(companyId, payload));
    } catch (e) {
      setPreview(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    setBusy('confirm'); setError(null);
    try {
      const r = await api.imports.confirmWebsite(companyId, payload);
      setResult(r);
      setPreview(null);
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button
        className={`${btnGhost} w-full`}
        data-testid="confirm-website-open"
        onClick={() => { reset(); setOpen(true); }}
        title="Record an official website you have confirmed from a source. Requires the site, the supporting evidence URL, and your reason."
      >
        {currentWebsite ? 'Correct website (with evidence)' : 'Confirm website (with evidence)'}
      </button>
    );
  }

  return (
    <div className="space-y-2" data-testid="confirm-website-panel">
      <p className="text-[10px] leading-relaxed text-slate-mid">
        No domain is ever guessed from a company name. Give the official site and the source that establishes
        it belongs to <span className="text-ink">{companyName}</span> — an official announcement, a filing, an
        accelerator page, or an investor announcement.
      </p>

      <div>
        <span className={label}>Official website URL</span>
        <input
          className={input} data-testid="confirm-website-url" placeholder="https://example.com"
          value={website} onChange={(e) => { setWebsite(e.target.value); setPreview(null); }}
        />
      </div>
      <div>
        <span className={label}>Supporting evidence URL</span>
        <input
          className={input} data-testid="confirm-website-evidence" placeholder="https://publisher.com/the-announcement"
          value={evidenceUrl} onChange={(e) => { setEvidenceUrl(e.target.value); setPreview(null); }}
        />
      </div>
      <div>
        <span className={label}>What the evidence establishes</span>
        <textarea
          className={`${input} h-16 resize-y`} data-testid="confirm-website-reason"
          placeholder="e.g. The company's own Series C announcement is hosted on this domain and states the amount the article reports."
          value={reason} onChange={(e) => { setReason(e.target.value); setPreview(null); }}
        />
        {reason.trim().length > 0 && reason.trim().length < 10 && (
          <p className="mt-0.5 text-[10px] text-alerta">At least 10 characters — this is the audit trail.</p>
        )}
      </div>

      {error && <p className="text-[11px] text-alerta" data-testid="confirm-website-error">{error}</p>}

      {preview && (
        <div className="border border-line border-l-[3px] border-l-marigold bg-panel px-2 py-1.5" data-testid="confirm-website-preview">
          <div className={label}>Previous → proposed</div>
          <div className="mt-1 divide-y divide-line">
            <Row name="Website" before={preview.previous.website ?? '(none on record)'} after={preview.proposed.website} />
            <Row name="Origin" before={preview.previous.websiteOrigin ?? '(none)'} after={preview.proposed.websiteOrigin} />
            <Row
              name="Class"
              before={preview.previous.classification ? OPPORTUNITY_CLASS_LABELS[preview.previous.classification] : '(unclassified)'}
              after="recomputed from evidence"
            />
            <Row
              name="Qualified"
              before={preview.previous.qualification ? QUALIFICATION_LABELS[preview.previous.qualification] : '(not qualified yet)'}
              after="re-checked live"
            />
            <Row name="Evidence" before="(not cited)" after={preview.proposed.evidenceUrl} />
          </div>
          <p className="mt-1.5 border-t border-line pt-1.5 text-[10px] leading-relaxed text-slate-mid">
            {preview.proposed.effect}
          </p>
          {preview.warnings.map((w) => (
            <p key={w} className="mt-1 text-[10px] leading-relaxed text-marigold">{w}</p>
          ))}
          {preview.blockers.map((b) => (
            <p key={b} className="mt-1 text-[10px] leading-relaxed text-alerta" data-testid="confirm-website-blocker">{b}</p>
          ))}
        </div>
      )}

      {result?.applied && (
        <div className="border border-line border-l-[3px] border-l-verde bg-panel px-2 py-1.5 text-[11px]" data-testid="confirm-website-result">
          <p className="text-ink">{result.message}</p>
          <p className="mt-0.5 font-mono text-[10px] text-slate-mid">
            Qualification: {QUALIFICATION_LABELS[result.applied.qualificationAfter]}. Recorded in classification history.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {!result && (
          <button
            className={`${btnGhost} w-full`} data-testid="confirm-website-preview-btn"
            disabled={!complete || busy !== null} onClick={runPreview}
          >
            {busy === 'preview' ? 'Checking…' : 'Preview change'}
          </button>
        )}
        {preview && preview.blockers.length === 0 && !result && (
          <button
            className={`${btnPrimary} w-full`} data-testid="confirm-website-confirm-btn"
            disabled={busy !== null} onClick={runConfirm}
          >
            {busy === 'confirm' ? 'Recording…' : 'Confirm and record'}
          </button>
        )}
        <button className={`${btnGhost} w-full`} onClick={() => { reset(); setOpen(false); }} disabled={busy !== null}>
          {result ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
