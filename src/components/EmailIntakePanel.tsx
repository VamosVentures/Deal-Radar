import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { EMAIL_INTAKE_PROMPT } from '../lib/emailIntakePrompt';
import { useIntegrations } from '../store/integrations';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';

/**
 * Email deal-flow intake — getting companies from a forwarded email into
 * the review queue below.
 *
 * With an AI key configured, the primary action is "Extract with Claude":
 * paste the email, the server sends it to Claude (budgeted and guarded —
 * server/services/emailIntake.ts's extractEmailWithAi). Without one, or as
 * a fallback when AI is switched off or over budget, the reviewer runs the
 * same prompt in their own Claude.ai chat and pastes the JSON reply back.
 * Either way every company lands in the review queue; nothing is created
 * until a human approves it.
 */
export function EmailIntakePanel({ onSubmitted }: { onSubmitted: () => void }) {
  const { status } = useIntegrations();
  const aiAvailable = status?.ai.connected === true;

  const [email, setEmail] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'extract' | 'submit' | null>(null);
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

  function report(res: { candidates: unknown[]; skipped: number }) {
    setSummary(
      res.candidates.length === 0
        ? 'No companies found in that email.'
        : `${res.candidates.length} compan${res.candidates.length === 1 ? 'y' : 'ies'} added to the review queue below.`
          + (res.skipped > 0 ? ` ${res.skipped} entr${res.skipped === 1 ? 'y' : 'ies'} had no name and were dropped.` : ''),
    );
    onSubmitted();
  }

  async function extract() {
    if (!email.trim()) return;
    setBusy('extract');
    setError(null);
    setSummary(null);
    try {
      report(await api.emailIntake.extractFromEmail(email));
      setEmail('');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!reply.trim()) return;
    setBusy('submit');
    setError(null);
    setSummary(null);
    try {
      report(await api.emailIntake.submitBatch(reply));
      setReply('');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  const manual = (
    <>
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
        <button type="button" className={`${btnPrimary} mt-1.5`} disabled={busy !== null || !reply.trim()} onClick={() => void submit()}>
          {busy === 'submit' ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </>
  );

  return (
    <section className="mt-8 border border-line bg-panel p-4">
      <h2 className="mb-1 font-display text-base font-semibold text-ink">Email deal flow</h2>

      {aiAvailable ? (
        <>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
            Paste a forwarded deal-flow email and Claude lists every company in it, with a proposed vertical for each.
            They land in the review queue below — nothing is created until you approve it.
          </p>
          <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-slate-mid" htmlFor="email-intake-email">
            Paste the email
          </label>
          <textarea
            id="email-intake-email"
            rows={8}
            className="w-full border border-line bg-paper px-2 py-1.5 text-[12px]"
            placeholder="Paste the full email text, including any forwarded part"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button type="button" className={btnPrimary} disabled={busy !== null || !email.trim()} onClick={() => void extract()}>
              {busy === 'extract' ? 'Extracting… (up to a minute)' : 'Extract with Claude'}
            </button>
            <span className="text-[10px] text-slate-mid">One AI call, usually a few cents.</span>
          </div>
          {summary && <p className="mt-1.5 text-[11px] text-slate-mid">{summary}</p>}
          {error && <div className="mt-1.5"><ErrorNote message={error.message} issues={error.issues} /></div>}

          <div className="mt-3 border-t border-line pt-3">
            <button type="button" className={btnGhost} onClick={() => setShowManual((v) => !v)}>
              {showManual ? 'Hide Claude.ai option' : 'Use Claude.ai instead (no AI call)'}
            </button>
            {showManual && <div className="mt-2">{manual}</div>}
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
            Run extraction yourself in your own Claude.ai chat (no AI key is configured for this app), then paste the
            reply here. Every company lands in the review queue below — nothing is created until you approve it.
          </p>
          {manual}
          {summary && <p className="mt-1.5 text-[11px] text-slate-mid">{summary}</p>}
          {error && <div className="mt-1.5"><ErrorNote message={error.message} issues={error.issues} /></div>}
        </>
      )}
    </section>
  );
}
