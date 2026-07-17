import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadStealthFounders } from '../data/loader';
import { verticalById } from '../data/taxonomy';
import type { Company, Founder, VerticalId } from '../types';
import { ConfidenceMeter, IdentityChips, PageHeader } from '../components/ui';
import { OutreachPanel } from '../components/OutreachPanel';
import { api } from '../lib/api';
import type { FounderHypothesis, StealthSignal } from '../../shared/discovery';
import { STEALTH_SIGNAL_TYPES } from '../../shared/discovery';

const ORDER: Record<'High' | 'Medium' | 'Low', number> = { High: 0, Medium: 1, Low: 2 };
const OWNERS = ['DR', 'MG', 'AL'];

export function StealthRadar() {
  const [tab, setTab] = useState<'feed' | 'queue' | 'watchlist'>('feed');
  const [signals, setSignals] = useState<StealthSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [outreachFor, setOutreachFor] = useState<Company | null>(null);

  const load = useCallback(() => {
    api.stealth.signals().then((r) => setSignals(r.signals)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const feed = useMemo(
    () => [...signals].sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]),
    [signals],
  );
  const queue = useMemo(
    () => feed.filter((s) => s.outreachStatus === 'Research queue' || s.verificationStatus === 'Unknown' || s.verificationStatus === 'Not verified'),
    [feed],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Pre-company signals"
        title="Stealth Founder Radar"
        blurb="Operators who may be building before it's public — from authorized public signals only (GitHub activity, filings, conference bios, grants, public announcements, or a profile URL a user pastes in). LinkedIn is never scraped, hypotheses stay labeled as hypotheses, and no outreach ever happens without a human writing and approving it."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {([['feed', `Signal feed (${feed.length})`], ['queue', `Research queue (${queue.length})`], ['watchlist', 'Sample watchlist']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-sm border px-3 py-1.5 ${tab === id ? 'border-verde bg-verde-soft font-semibold text-verde' : 'border-line text-slate-mid'}`}
          >
            {label}
          </button>
        ))}
        <button onClick={() => setShowAdd(true)} className="ml-auto rounded-sm bg-ink px-3 py-1.5 text-sm font-semibold text-white">
          + Add signal manually
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-alerta">{error} — is the API server running? (npm run dev starts both.)</p>}

      {tab !== 'watchlist' && (
        <div className="grid gap-3 lg:grid-cols-2">
          {(tab === 'feed' ? feed : queue).map((s) => (
            <SignalCard key={s.id} s={s} onChanged={load} onOutreach={(c) => setOutreachFor(c)} />
          ))}
          {(tab === 'feed' ? feed : queue).length === 0 && (
            <p className="text-sm text-slate-mid">Nothing here yet.</p>
          )}
        </div>
      )}

      {tab === 'watchlist' && <BundledWatchlist />}

      {showAdd && <AddSignalForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {outreachFor && <OutreachPanel c={outreachFor} onClose={() => setOutreachFor(null)} />}

      <p className="mt-5 max-w-3xl rounded-md border border-line bg-panel px-4 py-3 text-xs leading-relaxed text-slate-mid">
        <span className="font-semibold text-ink">Ground rules.</span> Confidence reflects the strength of public signals, not certainty about anyone's plans. Hypotheses are generated only from the recorded signal fields — never from names, photos, schools, locations, or networks — and are permanently labeled Hypothesis · Unverified · Requires human review, always with alternatives. No automated outreach is ever sent: a team member reviews each record, decides whether contact is appropriate, and approves any draft personally.
      </p>
    </div>
  );
}

// ── Signal card with detail, hypothesis, assignment, outreach ────

function SignalCard({ s, onChanged, onOutreach }: { s: StealthSignal; onChanged: () => void; onOutreach: (c: Company) => void }) {
  const [open, setOpen] = useState(false);
  const [hypothesis, setHypothesis] = useState<FounderHypothesis | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = async (p: Parameters<typeof api.stealth.patchSignal>[1]) => {
    await api.stealth.patchSignal(s.id, p);
    onChanged();
  };

  const genHypothesis = async () => {
    setBusy(true);
    try { setHypothesis(await api.stealth.hypothesis(s.id)); } finally { setBusy(false); }
  };

  const provisionalCompany = (): Company => {
    const founder: Founder = { name: s.founderName, role: s.previousRole !== 'Unknown' ? `Previously: ${s.previousRole}` : 'Unknown role', background: s.evidenceSummary };
    return {
      id: `stealth-${s.id}`,
      name: `${s.founderName} (stealth — unnamed)`,
      oneLiner: s.possibleTheme !== 'Unknown' ? `Possibly building in ${s.possibleTheme} (hypothesis — unverified)` : 'Possible new company — unverified signal',
      vertical: (s.possibleVertical === 'Unknown' ? 'aoi' : s.possibleVertical) as VerticalId,
      subcategory: 'Stealth — unclassified',
      stage: 'Stealth',
      city: 'Unknown', state: '??', foundedYear: new Date().getFullYear(), teamSize: 1,
      traction: { level: 0, note: 'Pre-company signal only' },
      founders: [founder],
      evidence: [{ claim: s.evidenceSummary, source: s.sourceName, url: s.sourceUrl, date: s.dateAccessed, type: 'News' }],
      flags: [],
    };
  };

  return (
    <article className="rounded-md border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold">{s.founderName}</h2>
          <p className="text-xs text-slate-mid">
            {s.previousRole !== 'Unknown' ? s.previousRole : 'Previous role unknown'}
            {s.previousEmployer !== 'Unknown' ? ` · ${s.previousEmployer}` : ''}
          </p>
        </div>
        <ConfidenceMeter level={s.confidence} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono font-semibold text-marigold">{s.signalType}</span>
        <span className="rounded-sm bg-paper px-1.5 py-0.5 text-slate-mid">{s.possibleVertical === 'Unknown' ? 'vertical unknown' : verticalById(s.possibleVertical as VerticalId).short}</span>
        <span className="rounded-sm bg-alerta-soft px-1.5 py-0.5 text-alerta">{s.verificationStatus}</span>
        {s.simulated && <span className="rounded-sm bg-paper px-1.5 py-0.5 text-slate-mid">simulated</span>}
        {s.outreachStatus !== 'None' && <span className="rounded-sm bg-paper px-1.5 py-0.5 font-semibold text-ink">{s.outreachStatus}</span>}
        {s.assignedTo && <span className="rounded-sm bg-verde-soft px-1.5 py-0.5 text-verde">owner: {s.assignedTo}</span>}
      </div>

      <p className="mt-2 text-xs text-ink">{s.evidenceSummary}</p>
      <p className="text-[11px] text-slate-mid">
        <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{s.sourceName}</a>
        {' '}· signal {s.signalDate} · accessed {s.dateAccessed}
      </p>

      <button onClick={() => setOpen((o) => !o)} className="mt-2 text-xs text-verde underline">
        {open ? 'Hide detail' : 'Detail, hypothesis & actions'}
      </button>

      {open && (
        <div className="mt-2 border-t border-line pt-2">
          <h3 className="mb-1 font-mono text-[10px] uppercase tracking-widest text-slate-mid">Evidence timeline</h3>
          <ul className="space-y-1 text-xs">
            <li><span className="font-mono text-[10px] text-slate-mid">{s.signalDate}</span> — {s.signalType}: {s.evidenceSummary}</li>
            <li><span className="font-mono text-[10px] text-slate-mid">{s.dateAccessed}</span> — recorded from {s.sourceName}</li>
          </ul>
          <p className="mt-1 text-[11px] text-slate-mid"><em>Alternative explanation:</em> {s.alternativeExplanation}</p>
          <p className="text-[11px] text-slate-mid"><em>Suggested next step:</em> {s.suggestedNextStep}</p>
          {(s.knownSkills.length > 0 || s.priorStartups.length > 0) && (
            <p className="text-[11px] text-slate-mid">
              {s.knownSkills.length > 0 && <>Recorded skills: {s.knownSkills.join(', ')}. </>}
              {s.priorStartups.length > 0 && <>Prior startups on record: {s.priorStartups.join('; ')}.</>}
            </p>
          )}

          <div className="mt-2">
            <button onClick={genHypothesis} disabled={busy} className="rounded-sm border border-line px-2 py-1 text-xs disabled:opacity-50">
              {busy ? 'Generating…' : hypothesis ? 'Regenerate hypothesis' : 'Generate hypothesis'}
            </button>
            {hypothesis && <HypothesisView h={hypothesis} />}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <label className="text-slate-mid">Owner:</label>
            <select
              value={s.assignedTo ?? ''}
              onChange={(e) => void patch({ assignedTo: e.target.value || null })}
              className="rounded-sm border border-line bg-panel px-1.5 py-1"
            >
              <option value="">Unassigned</option>
              {OWNERS.map((o) => <option key={o}>{o}</option>)}
            </select>
            <label className="text-slate-mid">Status:</label>
            <select
              value={s.outreachStatus}
              onChange={(e) => void patch({ outreachStatus: e.target.value as StealthSignal['outreachStatus'] })}
              className="rounded-sm border border-line bg-panel px-1.5 py-1"
            >
              {['None', 'Research queue', 'Outreach approved', 'Draft generated', 'Contacted'].map((o) => <option key={o}>{o}</option>)}
            </select>
            <button
              onClick={() => onOutreach(provisionalCompany())}
              className="ml-auto rounded-sm bg-verde px-2 py-1 font-semibold text-white"
              title="Opens the standard human-approval outreach flow — nothing is sent automatically."
            >
              Generate outreach draft
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function HypothesisView({ h }: { h: FounderHypothesis }) {
  return (
    <div className="mt-2 rounded-sm border border-alerta/40 bg-alerta-soft p-2 text-xs">
      <div className="mb-1 flex flex-wrap gap-1">
        <span className="rounded-sm bg-alerta px-1.5 py-0.5 text-[10px] font-bold text-white">HYPOTHESIS</span>
        <span className="rounded-sm bg-alerta px-1.5 py-0.5 text-[10px] font-bold text-white">UNVERIFIED</span>
        <span className="rounded-sm bg-alerta px-1.5 py-0.5 text-[10px] font-bold text-white">REQUIRES HUMAN REVIEW</span>
        <span className="rounded-sm bg-paper px-1.5 py-0.5 text-[10px] text-slate-mid">confidence band: {h.confidenceBand}</span>
      </div>
      <p><strong>Likely vertical:</strong> {h.likelyVertical}</p>
      <p><strong>Possible product area:</strong> {h.possibleProductArea}</p>
      <p className="mt-1 font-semibold">Supporting evidence</p>
      <ul className="list-disc pl-4">{h.supportingEvidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <p className="mt-1 font-semibold">Contradictory evidence</p>
      <ul className="list-disc pl-4">{h.contradictoryEvidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <p className="mt-1 font-semibold">Alternative hypotheses</p>
      <ul className="list-disc pl-4">{h.alternativeHypotheses.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <p className="mt-1 font-semibold">Missing information</p>
      <ul className="list-disc pl-4">{h.missingInformation.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

// ── Manual signal entry (incl. pasted public-profile URL) ───────

function AddSignalForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [founderName, setFounderName] = useState('');
  const [previousRole, setPreviousRole] = useState('');
  const [previousEmployer, setPreviousEmployer] = useState('');
  const [signalType, setSignalType] = useState<(typeof STEALTH_SIGNAL_TYPES)[number]>('User-provided public profile');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [evidenceSummary, setEvidenceSummary] = useState('');
  const [possibleVertical, setPossibleVertical] = useState('Unknown');
  const [confidence, setConfidence] = useState<'Low' | 'Medium' | 'High'>('Low');
  const [alt, setAlt] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const save = async () => {
    setErr(null);
    try {
      await api.stealth.addSignal({
        founderName,
        previousRole: previousRole || 'Unknown',
        previousEmployer: previousEmployer || 'Unknown',
        knownSkills: [], priorStartups: [], education: 'Unknown',
        signalType,
        signalDate: today,
        sourceName: sourceName || 'User-provided source',
        sourceUrl,
        dateAccessed: today,
        possibleVertical: possibleVertical as StealthSignal['possibleVertical'],
        possibleTheme: 'Unknown',
        evidenceSummary,
        confidence,
        verificationStatus: 'Not verified',
        alternativeExplanation: alt || 'Signal may be unrelated to founding a company.',
        suggestedNextStep: 'Review the source manually and verify before any outreach.',
        assignedTo: null,
        outreachStatus: 'None',
        simulated: false,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const input = 'w-full rounded-sm border border-line px-2 py-1.5 text-sm';
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-md bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-sm font-bold">Add stealth signal manually</h3>
        <p className="mb-3 text-[11px] text-slate-mid">
          Paste a public professional-profile URL or another authorized public source. The URL is stored as evidence for manual review — it is never crawled automatically, and restricted platforms are never scraped.
        </p>
        <div className="grid gap-2">
          <input className={input} placeholder="Founder name *" value={founderName} onChange={(e) => setFounderName(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className={input} placeholder="Previous role" value={previousRole} onChange={(e) => setPreviousRole(e.target.value)} />
            <input className={input} placeholder="Previous employer" value={previousEmployer} onChange={(e) => setPreviousEmployer(e.target.value)} />
          </div>
          <select className={input} value={signalType} onChange={(e) => setSignalType(e.target.value as typeof signalType)}>
            {STEALTH_SIGNAL_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input className={input} placeholder="Public source URL * (stored, not crawled)" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
          <input className={input} placeholder="Source name (e.g. conference bio, public GitHub)" value={sourceName} onChange={(e) => setSourceName(e.target.value)} />
          <textarea className={input} rows={2} placeholder="Evidence summary * — what the source actually says" value={evidenceSummary} onChange={(e) => setEvidenceSummary(e.target.value)} />
          <textarea className={input} rows={2} placeholder="Alternative explanation (kept alongside the signal)" value={alt} onChange={(e) => setAlt(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <select className={input} value={possibleVertical} onChange={(e) => setPossibleVertical(e.target.value)}>
              {['Unknown', 'health', 'fintech', 'fow', 'sustainability', 'aoi'].map((v) => <option key={v}>{v}</option>)}
            </select>
            <select className={input} value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)}>
              {['Low', 'Medium', 'High'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-sm border border-line px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={save} className="rounded-sm bg-verde px-3 py-1.5 text-sm font-semibold text-white">Save signal</button>
        </div>
      </div>
    </div>
  );
}

// ── Bundled sample watchlist (Phase 1 feature, preserved) ───────

function BundledWatchlist() {
  const founders = useMemo(loadStealthFounders, []);
  const [vertical, setVertical] = useState<'all' | VerticalId>('all');
  const rows = founders
    .filter((f) => vertical === 'all' || f.likelyVertical === vertical)
    .sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={vertical}
          onChange={(e) => setVertical(e.target.value as 'all' | VerticalId)}
          className="rounded-sm border border-line bg-panel px-2 py-1.5 text-xs"
          aria-label="Filter by likely vertical"
        >
          <option value="all">All likely verticals</option>
          {(['health', 'fintech', 'fow', 'sustainability', 'aoi'] as VerticalId[]).map((v) => (
            <option key={v} value={v}>{verticalById(v).name}</option>
          ))}
        </select>
        <span className="ml-auto font-mono text-[11px] text-slate-mid">{rows.length} founder(s) on sample watchlist</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((f) => (
          <article key={f.id} className="rounded-md border border-line bg-panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-bold">{f.name}</h2>
                <p className="text-xs text-slate-mid">{f.lastKnownRole}</p>
              </div>
              <ConfidenceMeter level={f.confidence} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-marigold">
                {verticalById(f.likelyVertical).short} · {f.likelyFocus}
              </span>
              <span className="text-slate-mid">{f.city}, {f.state}</span>
            </div>
            <div className="mt-2"><IdentityChips founders={[f]} /></div>
            <h3 className="mb-1 mt-3 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
              Signals ({f.signals.length})
            </h3>
            <ul className="space-y-1.5">
              {f.signals.map((s) => (
                <li key={s.url} className="text-xs">
                  <span className="text-ink">{s.signal}</span>{' '}
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{s.source}</a>{' '}
                  <span className="font-mono text-[10px] text-slate-mid">{s.date}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}
