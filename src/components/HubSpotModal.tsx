import { useMemo, useState } from 'react';
import type { Company } from '../types';
import { scoreCompany } from '../lib/scoring';
import { companyToHubSpot, dealToHubSpot, founderToHubSpot, recommendationFor } from '../lib/crm';
import { api, ApiError } from '../lib/api';
import { useIntegrations } from '../store/integrations';
import { ExceptionBadge, ScoreGauge } from './ui';
import { btnGhost, btnPrimary, ErrorNote, Field, Modal } from './Modal';
import {
  normalizeDomain,
  RADAR_HUBSPOT_STAGES,
  type DuplicateMatch,
  type RadarHubSpotStage,
  type SyncResult,
} from '../../shared/integrations';

const OWNERS = ['DR', 'MG', 'AL', 'Unassigned'];

type Step = 'review' | 'duplicates' | 'done';

/**
 * Mandatory human-review modal in front of every HubSpot submission:
 * every field is editable, duplicates are surfaced before anything is
 * created, and nothing is written until the reviewer confirms.
 */
export function HubSpotModal({ c, onClose, onSynced }: { c: Company; onClose: () => void; onSynced?: () => void }) {
  const { status } = useIntegrations();
  const fit = useMemo(() => scoreCompany(c), [c]);

  const [company, setCompany] = useState(() => companyToHubSpot(c));
  const [owner, setOwner] = useState('DR');
  const [nextAction, setNextAction] = useState('Review evidence and approve outreach');
  const [notes, setNotes] = useState('');
  const [radarStage, setRadarStage] = useState<RadarHubSpotStage>('Approved to Track');
  const [contacts, setContacts] = useState(() => c.founders.map((f) => founderToHubSpot(c, f, 'DR')));

  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const [result, setResult] = useState<SyncResult | null>(null);

  const hubspotNotConnected = status ? status.hubspot.mode !== 'live' : false;

  const setCompanyField = (k: keyof typeof company) => (v: string) =>
    setCompany((prev) => ({ ...prev, [k]: v || null }));

  async function runDuplicateCheck() {
    setBusy(true);
    setError(null);
    try {
      const { matches } = await api.hubspot.checkDuplicate({
        name: company.name,
        domain: company.domain,
        founderEmails: contacts.map((ct) => ct.email).filter((e): e is string => !!e),
        dealRadarId: c.id,
      });
      setMatches(matches);
      if (matches.length === 0) {
        await submit('create-new', null);
      } else {
        setStep('duplicates');
      }
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function submit(resolution: 'create-new' | 'update-existing', existingRecordId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const reviewer = owner === 'Unassigned' ? null : owner;
      const base = dealToHubSpot(c, reviewer, nextAction, reviewer);
      const deal = {
        ...base,
        rationale: notes ? `${notes} — ${base.rationale}` : base.rationale,
      };
      const res = await api.hubspot.syncCompany({
        company: { ...company, domain: normalizeDomain(company.website) },
        contacts: contacts.map((ct) => ({ ...ct, relationshipOwner: owner === 'Unassigned' ? null : owner })),
        deal,
        radarStage,
        duplicateResolution: resolution,
        existingRecordId,
      });
      setResult(res);
      setStep('done');
      onSynced?.();
    } catch (e) {
      setError(e as ApiError);
      setStep('review');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={step === 'done' ? 'Added to HubSpot' : `Review before adding ${c.name} to HubSpot`}
      eyebrow="HubSpot sync"
      onClose={onClose}
      wide
    >
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <ScoreGauge score={fit.score} />
            <div>
              <div className="text-sm font-semibold">{recommendationFor(fit.score)}</div>
              <div className="text-xs text-slate-mid">Vamos Fit Score {fit.score.toFixed(1)} / 10 · {c.stage} · {c.city}, {c.state}</div>
            </div>
          </div>

          {hubspotNotConnected && (
            <ErrorNote
              message="This integration is not connected."
              hint="Add HubSpot credentials to the backend .env (see .env.example), then reload. Nothing can sync until then."
            />
          )}

          {fit.exceptions.length > 0 && (
            <div className="space-y-1.5">
              {fit.exceptions.map((e) => (
                <div key={e.flag} className="rounded-sm border border-alerta/40 bg-alerta-soft px-3 py-2 text-xs">
                  <ExceptionBadge flag={e.flag} /> <span className="mt-1 block text-ink/80">{e.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name" value={company.name} onChange={setCompanyField('name')} />
            <Field label="Website" value={company.website ?? ''} onChange={setCompanyField('website')} placeholder="https:// — leave empty if unknown" />
            <Field label="Vertical" value={company.vertical} onChange={setCompanyField('vertical')} />
            <Field label="Subcategory" value={company.subcategory} onChange={setCompanyField('subcategory')} />
            <Field label="Stage" value={company.stage} onChange={setCompanyField('stage')} />
            <Field label="Headquarters" value={`${company.city}, ${company.state}`} onChange={(v) => {
              const [city, state = ''] = v.split(',');
              setCompany((p) => ({ ...p, city: city.trim(), state: state.trim() }));
            }} />
            <Field label="Accelerator" value={company.accelerator ?? ''} onChange={setCompanyField('accelerator')} placeholder="Only if verified" />
            <Field label="Funding raised" value={company.fundingRaised ?? ''} onChange={setCompanyField('fundingRaised')} placeholder="e.g. $3.5M seed" />
          </div>
          <Field label="Company description" value={company.description} onChange={setCompanyField('description')} textarea />
          <Field label="Sourcing notes (added to the deal rationale)" value={notes} onChange={setNotes} textarea placeholder="Optional analyst notes" />

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
              Suggested HubSpot stage
              <select value={radarStage} onChange={(e) => setRadarStage(e.target.value as RadarHubSpotStage)} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case">
                {RADAR_HUBSPOT_STAGES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
              Relationship owner
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case">
                {OWNERS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <Field label="Next action" value={nextAction} onChange={setNextAction} />
          </div>

          <section>
            <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Founder contacts ({contacts.length})</h3>
            <div className="space-y-2">
              {contacts.map((ct, i) => (
                <div key={i} className="grid gap-2 rounded-sm border border-line bg-paper p-2.5 sm:grid-cols-3">
                  <Field label="Name" value={`${ct.firstName} ${ct.lastName}`.trim()} onChange={(v) => {
                    const [firstName, ...rest] = v.split(' ');
                    setContacts((prev) => prev.map((x, j) => j === i ? { ...x, firstName, lastName: rest.join(' ') } : x));
                  }} />
                  <Field label="Email (verified only)" value={ct.email ?? ''} onChange={(v) =>
                    setContacts((prev) => prev.map((x, j) => j === i ? { ...x, email: v || null } : x))
                  } placeholder="No verified email on record" />
                  <Field label="LinkedIn" value={ct.linkedinUrl ?? ''} onChange={(v) =>
                    setContacts((prev) => prev.map((x, j) => j === i ? { ...x, linkedinUrl: v || null } : x))
                  } placeholder="Public profile URL" />
                  <div className="sm:col-span-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-mid">
                    <span className="font-mono uppercase">{ct.jobTitle}</span>
                    <span>· source: {ct.infoSource}</span>
                    <span>· {ct.verificationStatus}</span>
                    {ct.demographics.length > 0 ? (
                      <span className="rounded-sm bg-verde-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-verde" title={ct.demographics.map((d) => `${d.indicator}: ${d.basis} — ${d.sourceName}`).join('\n')}>
                        {ct.demographics.map((d) => d.indicator).join(', ')} ✓ verified
                      </span>
                    ) : (
                      <span className="italic">Identity not on record — never inferred</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Evidence going into the record ({c.evidence.length})</h3>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
              {c.evidence.map((e) => (
                <li key={e.url} className="flex flex-wrap gap-1.5 text-slate-mid">
                  <span className="text-ink">{e.claim}</span>
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{e.source}</a>
                  <span className="font-mono text-[10px]">{e.date}</span>
                </li>
              ))}
            </ul>
          </section>

          {error && <ErrorNote message={error.message} hint={error.hint} issues={error.issues} />}

          <footer className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button className={btnGhost} onClick={onClose}>Cancel</button>
            <button className={btnPrimary} onClick={runDuplicateCheck} disabled={busy || !company.name.trim() || hubspotNotConnected}>
              {busy ? 'Checking for duplicates…' : 'Check duplicates & add to HubSpot'}
            </button>
          </footer>
        </div>
      )}

      {step === 'duplicates' && (
        <div className="space-y-3">
          <p className="text-sm">
            {matches.length} possible existing record{matches.length === 1 ? '' : 's'} found in HubSpot
            {matches[0]?.matchedOn === 'domain' ? ' with the same domain' : ' with a matching name'}.
            Nothing was created yet — choose how to proceed.
          </p>
          <div className="space-y-2">
            {matches.map((m) => (
              <div key={m.recordId} className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-paper px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{m.name}</div>
                  <div className="font-mono text-[11px] text-slate-mid">
                    {m.domain ?? 'no domain'} · matched on {m.matchedOn} · id {m.recordId}
                  </div>
                </div>
                {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="text-xs text-verde underline">View in HubSpot</a>}
                <button className={btnPrimary} onClick={() => submit('update-existing', m.recordId)} disabled={busy}>
                  Update this record
                </button>
              </div>
            ))}
          </div>
          {error && <ErrorNote message={error.message} hint={error.hint} issues={error.issues} />}
          <footer className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button className={btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
            <button className={btnGhost} onClick={() => setStep('review')} disabled={busy}>Back to review</button>
            <button className={btnPrimary} onClick={() => submit('create-new', null)} disabled={busy}>
              {busy ? 'Submitting…' : 'Create a new record anyway'}
            </button>
          </footer>
        </div>
      )}

      {step === 'done' && result && (
        <div className="space-y-3">
          <div className="rounded-sm bg-verde-soft px-3 py-2 text-sm text-verde">
            <div className="flex items-center gap-2 font-semibold">
              Saved — company {result.action}, {result.contactIds.length} contact{result.contactIds.length === 1 ? '' : 's'}, 1 deal
            </div>
            <p className="mt-1 text-xs text-ink/80">{result.message}</p>
          </div>
          <div className="font-mono text-[11px] text-slate-mid">
            Company id {result.companyId} · deal id {result.dealId}
          </div>
          {result.companyUrl && (
            <a href={result.companyUrl} target="_blank" rel="noreferrer" className="inline-block text-sm text-verde underline">
              Open company in HubSpot →
            </a>
          )}
          <footer className="flex justify-end gap-2 border-t border-line pt-3">
            <button className={btnPrimary} onClick={onClose}>Done</button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
