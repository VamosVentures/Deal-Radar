import { useMemo, useState } from 'react';
import type { Company, Founder } from '../types';
import { outreachContext } from '../lib/crm';
import { api, ApiError } from '../lib/api';
import { useIntegrations } from '../store/integrations';
import { btnGhost, btnPrimary, DemoBadge, ErrorNote, Field, Modal } from './Modal';
import { OUTREACH_TONES, type EmailGenContext, type GeneratedEmail, type OutreachTone } from '../../shared/integrations';

/**
 * AI drafts, humans send. This panel generates a draft from verified
 * radar facts only, requires the reviewer to look at (and freely edit)
 * every field, and offers exactly ONE email action: Save to Outlook
 * Drafts. There is intentionally no send button anywhere in the app —
 * the email is sent by a person, from Outlook.
 */
export function OutreachPanel({ c, onClose, onSaved }: { c: Company; onClose: () => void; onSaved?: () => void }) {
  const { status } = useIntegrations();
  const [founderIdx, setFounderIdx] = useState(0);
  const founder: Founder = c.founders[founderIdx];

  const [senderName, setSenderName] = useState('Daniela Reyes');
  const [senderRole, setSenderRole] = useState('Partner');
  const [tone, setTone] = useState<OutreachTone>('Warm and conversational');
  const [customInstructions, setCustomInstructions] = useState('');
  const [meetingAsk, setMeetingAsk] = useState('a 25-minute intro call in the next two weeks');

  const baseContext: EmailGenContext = useMemo(
    () => outreachContext(c, founder, { name: senderName, role: senderRole }),
    [c, founder, senderName, senderRole],
  );

  const [email, setEmail] = useState<GeneratedEmail | null>(null);
  const [to, setTo] = useState(founder.email ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<{ demo: boolean; message: string; webLink: string | null } | null>(null);

  const outlookDemo = status?.outlook.mode !== 'live';

  function contextWithTone(): EmailGenContext {
    return { ...baseContext, tone, customInstructions, meetingAsk };
  }

  async function generate(regenInstructions?: string) {
    setBusy('generate');
    setError(null);
    try {
      const result = regenInstructions !== undefined
        ? await api.outreach.regenerate(contextWithTone(), regenInstructions)
        : await api.outreach.generate(contextWithTone());
      setEmail(result);
      setSubject(result.subject);
      setBody(result.body);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    setBusy('save');
    setError(null);
    try {
      const res = await api.outlook.saveDraft({
        companyId: c.id,
        to,
        subject,
        body,
        senderName,
        tone,
      });
      setSaved({ demo: res.demo, message: res.message, webLink: res.webLink });
      onSaved?.();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={`Founder outreach — ${c.name}`} eyebrow="Generate · review · save as draft" onClose={onClose} wide>
      {saved ? (
        <div className="space-y-3">
          <div className={`rounded-sm px-3 py-2 text-sm ${saved.demo ? 'bg-marigold-soft' : 'bg-verde-soft text-verde'}`}>
            <div className="flex items-center gap-2 font-semibold">
              Draft saved <DemoBadge show={saved.demo} />
            </div>
            <p className="mt-1 text-xs text-ink/80">{saved.message}</p>
            <p className="mt-1 text-xs text-ink/80">
              Outreach status is now <span className="font-semibold">Saved to Outlook</span>. The email has NOT been sent —
              open Outlook, review once more, and send it yourself. Then mark it as sent in the Outreach Pipeline.
            </p>
          </div>
          {saved.webLink && (
            <a href={saved.webLink} target="_blank" rel="noreferrer" className="inline-block text-sm text-verde underline">
              Open in Outlook →
            </a>
          )}
          <footer className="flex justify-end border-t border-line pt-3">
            <button className={btnPrimary} onClick={onClose}>Done</button>
          </footer>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
              Founder
              <select
                value={founderIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  setFounderIdx(idx);
                  setTo(c.founders[idx].email ?? '');
                  setEmail(null);
                }}
                className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case"
              >
                {c.founders.map((f, i) => (
                  <option key={f.name} value={i}>
                    {f.name} — {f.role}{f.email ? '' : ' (no verified email)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
              Tone
              <select value={tone} onChange={(e) => setTone(e.target.value as OutreachTone)} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case">
                {OUTREACH_TONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <Field label="Sender name" value={senderName} onChange={setSenderName} />
            <Field label="Sender role" value={senderRole} onChange={setSenderRole} />
            <Field label="Meeting ask" value={meetingAsk} onChange={setMeetingAsk} />
            {tone === 'Custom' && (
              <Field label="Custom instructions" value={customInstructions} onChange={setCustomInstructions} placeholder="e.g. mention we saw them at SXSW only if true…" />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-paper px-3 py-2 text-[11px] text-slate-mid">
            <span className="font-mono uppercase tracking-wider">Facts available:</span>
            <Chip ok={!!baseContext.verifiedFounderDetail} label="Verified founder detail" />
            <Chip ok={!!baseContext.recentMilestone} label="Recent milestone" />
            <Chip ok={!!baseContext.acceleratorOrFunding} label="Accelerator / funding" />
            <Chip ok={baseContext.sourceLinks.length > 0} label={`${baseContext.sourceLinks.length} sources`} />
            <span className="ml-auto"><DemoBadge show={status?.ai.mode !== 'live'} /></span>
          </div>

          {!email && (
            <button className={btnPrimary} onClick={() => generate()} disabled={busy !== null}>
              {busy === 'generate' ? 'Generating…' : 'Generate draft from verified facts'}
            </button>
          )}

          {email && (
            <div className="space-y-3">
              {email.weakEvidence && (
                <div className="rounded-sm border border-marigold/50 bg-marigold-soft px-3 py-2 text-xs">
                  <span className="font-semibold">Weak personalization evidence.</span> {email.warnings.join(' ')}
                </div>
              )}
              {!email.weakEvidence && email.warnings.length > 0 && (
                <div className="rounded-sm bg-paper px-3 py-2 text-xs text-slate-mid">{email.warnings.join(' ')}</div>
              )}

              <Field label="To (recipient — verified emails only)" value={to} onChange={setTo} placeholder="No verified email on record — add one only if verified" />
              <Field label="Subject" value={subject} onChange={setSubject} />
              <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
                Body (edit freely — you are the author of record)
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case leading-relaxed" />
              </label>

              <div className="rounded-sm border border-line bg-paper px-3 py-2 text-xs">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Why this draft says what it says</div>
                <p className="mt-1 text-ink/80">{email.rationale}</p>
                <button className="mt-1.5 text-verde underline decoration-dotted" onClick={() => setShowEvidence((s) => !s)}>
                  {showEvidence ? 'Hide' : 'View'} supporting evidence ({email.sources.length})
                </button>
                {showEvidence && (
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-slate-mid">
                    {email.sources.length === 0 && <li>No source links were provided for this company.</li>}
                    {email.sources.map((s) => (
                      <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{s.label}</a></li>
                    ))}
                  </ul>
                )}
              </div>

              {error && <ErrorNote message={error.message} hint={error.hint} issues={error.issues} />}

              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
                <button className={btnGhost} onClick={onClose} disabled={busy !== null}>Cancel</button>
                <button className={btnGhost} onClick={() => generate('')} disabled={busy !== null}>
                  {busy === 'generate' ? 'Regenerating…' : 'Regenerate'}
                </button>
                <button
                  className={btnPrimary}
                  onClick={saveDraft}
                  disabled={busy !== null || !to || !subject.trim() || !body.trim()}
                  title={!to ? 'Add a verified recipient email first' : undefined}
                >
                  {busy === 'save' ? 'Saving…' : outlookDemo ? 'Save to Outlook Drafts (Demo Mode)' : 'Save to Outlook Drafts'}
                </button>
              </footer>
              <p className="text-right font-mono text-[10px] text-slate-mid">
                Saving creates a DRAFT only. Sending always happens manually, by you, from Outlook.
              </p>
            </div>
          )}

          {!email && error && <ErrorNote message={error.message} hint={error.hint} issues={error.issues} />}
        </div>
      )}
    </Modal>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold ${ok ? 'bg-verde-soft text-verde' : 'bg-line text-slate-mid line-through'}`}>
      {label}
    </span>
  );
}
