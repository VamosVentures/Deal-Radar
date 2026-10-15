import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { EMAIL_INTAKE_PROMPT } from '../lib/emailIntakePrompt';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';

/**
 * Email deal-flow intake — the paste-back half of the flow.
 *
 * No AI provider is configured for this app (see EMAIL_INTAKE_PROMPT's
 * header comment), so there is no "extract" button here that calls a
 * model. Two independent pieces: a one-time reference for setting up a
 * Claude.ai Project, and the actual per-email action, which is just
 * submitting whatever Claude replied with.
 */
export function EmailIntakePanel({ onSubmitted }: { onSubmitted: () => void }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(EMAIL_INTAKE_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the prompt is
      // still selectable/readable in the textarea below either way.
    }
  }

  async function submit() {
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await api.emailIntake.submitBatch(reply);
      setSummary(
        `${res.candidates.length} compan${res.candidates.length === 1 ? 'y' : 'ies'} added to the review queue.`
        + (res.skipped > 0 ? ` ${res.skipped} entr${res.skipped === 1 ? 'y' : 'ies'} had no name and were dropped.` : ''),
      );
      setReply('');
      onSubmitted();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 border border-line bg-panel p-4">
      <h2 className="mb-1 font-display text-base font-semibold text-ink">Email deal flow</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        Run extraction yourself in your own Claude.ai chat (no API key configured for this app), then paste the
        reply here. Every company lands in the review queue below — nothing is created until you approve it.
      </p>

      <button type="button" className={btnGhost} onClick={() => setShowPrompt((v) => !v)}>
        {showPrompt ? 'Hide' : 'Set up your Claude Project'}
      </button>
      {showPrompt && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="mb-1.5 text-[11px] leading-relaxed text-slate-mid">
            Copy this once into a new Claude.ai Project&rsquo;s custom instructions. From then on, just paste a
            forwarded email into that project&rsquo;s chat and copy its reply back here — no need to open this box again.
          </p>
          <textarea
            readOnly
            rows={6}
            className="w-full border border-line bg-paper px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink"
            value={EMAIL_INTAKE_PROMPT}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className={`${btnGhost} mt-1.5`} onClick={() => void copyPrompt()}>
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-slate-mid" htmlFor="email-intake-reply">
          Paste Claude&rsquo;s reply
        </label>
        <textarea
          id="email-intake-reply"
          rows={6}
          className="w-full border border-line bg-paper px-2 py-1.5 text-[12px]"
          placeholder='{"candidates": [...]}'
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        <button type="button" className={`${btnPrimary} mt-1.5`} disabled={busy || !reply.trim()} onClick={() => void submit()}>
          {busy ? 'Submitting…' : 'Submit'}
        </button>
        {summary && <p className="mt-1.5 text-[11px] text-slate-mid">{summary}</p>}
        {error && <div className="mt-1.5"><ErrorNote message={error.message} issues={error.issues} /></div>}
      </div>
    </section>
  );
}
