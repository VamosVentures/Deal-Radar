import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/ui';
import { StealthSignalFeed } from '../components/StealthSignalFeed';
import { api } from '../lib/api';
import {
  RADAR_FILTERS, RADAR_FILTER_LABELS,
  type RadarEntry, type RadarFilter, type RadarPerson,
} from '../../shared/enrichment';

/**
 * Stealth Founder Radar.
 *
 * This page used to be a feed of hand-entered signals with a
 * deterministic template stapled on top. It could not answer the only
 * question it existed to answer — "who is behind this company?" —
 * because it was never connected to the companies. "Stealth" was a
 * label, not a finding.
 *
 * It is now a research workflow over the real company records: each row
 * is a company the pipeline has examined and found to have a low public
 * profile, carrying the evidence behind every match, the source families
 * attempted, the last-checked date, and the next action. The manual
 * signal feed is preserved below, because recording a signal a human
 * spotted is still worth doing — it is just no longer the whole feature.
 *
 * Two rendering rules this page exists to hold:
 *
 *   1. Verified founders and candidates come from SEPARATE arrays and
 *      are rendered by separate blocks. A probable candidate cannot
 *      appear as a verified founder through a template mistake, because
 *      it is never in the verified list.
 *
 *   2. Conflicts are shown as conflicts. When two sources name different
 *      people, both appear with their sources. Picking one and showing
 *      it confidently is how a wrong person reaches an outreach email.
 *
 * All third-party text — names, titles, quoted supporting text — is
 * rendered as plain text. No dangerouslySetInnerHTML.
 */

function PersonCard({
  person, verified, onReviewed,
}: { person: RadarPerson; verified: boolean; onReviewed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = async (decision: 'confirmed' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await api.stealth.reviewCandidate(person.candidateId, decision, reason.trim());
      setOpen(false);
      setReason('');
      onReviewed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="radar-person"
      className={`border-l-2 pl-2 ${verified ? 'border-verde' : 'border-line'} ${person.reviewDecision === 'rejected' ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold text-ink">{person.fullName}</span>
        {person.title && <span className="text-xs text-slate-mid">{person.title}</span>}
        {verified
          ? <span className="rounded-[2px] border border-verde/30 bg-verde-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-verde">Verified</span>
          : <span className="rounded-[2px] border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-slate-mid">Candidate — unconfirmed</span>}
        {person.reviewDecision && (
          <span className={`font-mono text-[10px] ${person.reviewDecision === 'confirmed' ? 'text-verde' : 'text-alerta'}`}>
            {person.reviewDecision} by {person.reviewedBy} · {person.reviewedAt?.slice(0, 10)}
          </span>
        )}
      </div>

      <div className="text-[11px] text-slate-mid">
        {person.sourceFamilyLabel} ·{' '}
        <a href={person.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">
          source
        </a>
        {person.publishedAt && <> · {person.publishedAt}</>}
        {' '}· match score {person.matchScore} · confidence {(person.confidence * 100).toFixed(0)}%
      </div>

      {/* Why this person is tied to THIS company. A shared name scores
          nothing and can never appear here on its own. */}
      {person.matchEvidence.length > 0 && (
        <ul className="mt-0.5 list-inside list-disc text-[11px] text-slate-mid">
          {person.matchEvidence.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
      {person.supportingText && (
        <p className="mt-0.5 text-[11px] italic text-slate-mid">“{person.supportingText}”</p>
      )}

      {!person.reviewDecision && (
        open ? (
          <div className="mt-1.5 space-y-1.5">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why? (required — the automated evidence is kept either way)"
              data-testid="candidate-review-reason"
              className="w-full border border-line px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
              <button
                onClick={() => review('confirmed')}
                disabled={busy || reason.trim().length < 3}
                data-testid="candidate-confirm"
                className="rounded-[2px] bg-verde px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
              >
                Confirm founder
              </button>
              <button
                onClick={() => review('rejected')}
                disabled={busy || reason.trim().length < 3}
                data-testid="candidate-reject"
                className="rounded-[2px] border border-alerta px-2.5 py-1 text-[11px] font-semibold text-alerta disabled:opacity-40"
              >
                Reject
              </button>
              <button onClick={() => setOpen(false)} className="px-2 py-1 text-[11px] text-slate-mid">Cancel</button>
            </div>
            {error && <p className="text-[11px] text-alerta">{error}</p>}
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            data-testid="candidate-review-open"
            className="mt-1 text-[11px] text-slate-mid underline decoration-dotted hover:text-ink"
          >
            Confirm or reject…
          </button>
        )
      )}
    </div>
  );
}

function RadarRow({ entry, onReviewed }: { entry: RadarEntry; onReviewed: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="border border-line bg-panel p-3" data-testid="radar-entry">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-base font-semibold text-ink">{entry.companyName}</h3>
        <span className="rounded-[2px] border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-mid">
          {entry.statusLabel}
        </span>
        {(entry.city || entry.state) && (
          <span className="text-[11px] text-slate-mid">{[entry.city, entry.state].filter(Boolean).join(', ')}</span>
        )}
        {entry.website && (
          <a href={entry.website} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-mid underline decoration-dotted">
            website
          </a>
        )}
        <span className="ml-auto font-mono text-[10px] text-slate-mid">
          {entry.progress.answered}/{entry.progress.total} sources answered
          {entry.lastCheckedAt && ` · checked ${entry.lastCheckedAt.slice(0, 10)}`}
        </span>
      </header>

      <p className="mt-1 text-xs leading-relaxed text-slate-mid">{entry.stealthReason}</p>

      {entry.conflicts.length > 0 && (
        <div className="mt-2 border-l-2 border-alerta/50 bg-alerta/5 p-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alerta">
            Sources disagree — no person has been selected
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {entry.conflicts.map((c, i) => (
              <li key={i} className="text-[11px] text-slate-mid">
                {c.detail} ·{' '}
                <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.verifiedFounders.length > 0 && (
        <section className="mt-2">
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-verde">Verified founders</h4>
          <div className="mt-1 space-y-1.5">
            {entry.verifiedFounders.map((p) => (
              <PersonCard key={p.candidateId} person={p} verified onReviewed={onReviewed} />
            ))}
          </div>
        </section>
      )}

      {entry.candidates.length > 0 && (
        <section className="mt-2">
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            Candidates — unconfirmed ({entry.candidates.length})
          </h4>
          <div className="mt-1 space-y-1.5">
            {entry.candidates.slice(0, expanded ? undefined : 3).map((p) => (
              <PersonCard key={p.candidateId} person={p} verified={false} onReviewed={onReviewed} />
            ))}
          </div>
          {entry.candidates.length > 3 && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-[11px] text-slate-mid underline decoration-dotted">
              {expanded ? 'Show fewer' : `Show all ${entry.candidates.length}`}
            </button>
          )}
        </section>
      )}

      <p className="mt-2 border-t border-line pt-1.5 text-[11px] text-slate-mid">
        <span className="font-mono uppercase tracking-widest">Next</span> · {entry.nextAction}
      </p>

      <details className="mt-1.5">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-slate-mid">
          Research record, relationships, and filing facts
        </summary>

        <div className="mt-1.5 space-y-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Sources attempted</p>
            <ul className="mt-0.5 space-y-0.5">
              {entry.progress.families.map((f) => (
                <li key={f.family} className="text-[11px]">
                  <span className="font-semibold text-ink">{f.label}</span>{' '}
                  <span className="font-mono text-slate-mid">{f.outcome}</span>
                  <div className="text-slate-mid">{f.detail}</div>
                </li>
              ))}
            </ul>
          </div>

          {entry.filingFacts.length > 0 && (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Filing facts</p>
              <ul className="mt-0.5 space-y-0.5">
                {entry.filingFacts.map((f, i) => (
                  <li key={i} className="text-[11px] text-slate-mid">
                    {f.label}: <span className="text-ink">{f.value}</span>
                    {f.url && (
                      <>
                        {' '}
                        <a href={f.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {entry.financing.length > 0 && (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Financing evidence</p>
              <ul className="mt-0.5 space-y-0.5">
                {entry.financing.map((f, i) => (
                  <li key={i} className="text-[11px] text-slate-mid">
                    {f.roundType ?? 'Round not named by the source'}
                    {f.amountText && ` · ${f.amountText}`}
                    {f.investors.length > 0 && ` · ${f.investors.join(', ')}`}
                    {f.publishedAt && ` · ${f.publishedAt}`}
                    {' '}
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {entry.relationships.length > 0 && (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
                Evidence-backed relationships ({entry.relationships.length})
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {entry.relationships.slice(0, 12).map((r, i) => (
                  <li key={i} className="text-[11px] text-slate-mid">
                    <span className="font-mono">{r.relation}</span> → {r.toType}:{r.to}{' '}
                    <a href={r.evidenceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">source</a>
                    {' '}· {(r.confidence * 100).toFixed(0)}%
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </article>
  );
}

export function StealthRadar() {
  const [entries, setEntries] = useState<RadarEntry[]>([]);
  const [counts, setCounts] = useState<Record<RadarFilter, number> | null>(null);
  const [filter, setFilter] = useState<RadarFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hints, setHints] = useState<{ aId: string; aName: string; bId: string; bName: string; basis: string }[]>([]);
  const [showSignals, setShowSignals] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.stealth.radar(filter)
      .then((r) => { setEntries(r.entries); setCounts(r.counts); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(load, [load]);
  useEffect(() => {
    api.stealth.duplicateHints().then((r) => setHints(r.hints)).catch(() => setHints([]));
  }, []);

  return (
    <div data-testid="stealth-radar">
      <PageHeader
        eyebrow="Founder research"
        title="Stealth Founder Radar"
        blurb="Companies the research pipeline has examined and found to have a low public profile — financing evidence exists, but the founders are not publicly attributable or the sources disagree. Every match shows the evidence tying a person to the company; a shared name is never a match. Verified founders and unconfirmed candidates are kept separate, conflicts are shown rather than resolved automatically, and nothing about demographic identity is ever inferred."
      />

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {RADAR_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            data-testid={`radar-filter-${f}`}
            className={`rounded-[2px] border px-2.5 py-1 text-xs font-semibold transition-colors ${
              filter === f ? 'border-ink bg-ink text-white' : 'border-line bg-panel text-slate-mid hover:text-ink'
            }`}
          >
            {RADAR_FILTER_LABELS[f]}
            {counts && <span className="ml-1.5 font-mono tabular-nums opacity-70">{counts[f] ?? 0}</span>}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 text-sm text-alerta">
          {error} — is the API server running? (npm run dev starts both.)
        </p>
      )}

      {hints.length > 0 && (
        <div className="mb-3 border border-marigold/40 bg-marigold/5 p-2.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            Possible duplicate records ({hints.length}) — reported, never merged automatically
          </p>
          <ul className="mt-1 space-y-0.5">
            {hints.slice(0, 6).map((h, i) => (
              <li key={i} className="text-[11px] text-slate-mid">
                <span className="text-ink">{h.aName}</span> ↔ <span className="text-ink">{h.bName}</span> · {h.basis}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-slate-mid">
            Resolve these in the possible-duplicate review queue, where a merge keeps both records’ evidence.
          </p>
        </div>
      )}

      {loading && entries.length === 0 && <p className="text-sm text-slate-mid">Loading research records…</p>}

      {!loading && entries.length === 0 && !error && (
        <div className="border border-line bg-panel p-4" data-testid="radar-empty">
          <p className="text-sm text-slate-mid">
            No companies match this filter. The radar lists companies that have BEEN researched and came back
            without a publicly attributable founder — a company nobody has looked at yet is not a stealth company,
            and listing it as one would fill this page with our own backlog rather than with findings.
          </p>
          <p className="mt-2 text-xs text-slate-mid">
            Run <code className="font-mono">npm run db:enrich -- --apply</code> to research the pipeline.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {entries.map((e) => <RadarRow key={e.companyId} entry={e} onReviewed={load} />)}
      </div>

      {/*
        The manual signal feed. Kept because recording a signal a human
        spotted is still worth doing — it is simply no longer the whole
        feature, and it never answered the founder question on its own.
      */}
      <section className="mt-6 border-t border-line pt-4">
        <button
          onClick={() => setShowSignals((v) => !v)}
          className="font-mono text-[11px] uppercase tracking-widest text-slate-mid hover:text-ink"
        >
          {showSignals ? '▾' : '▸'} Manually recorded pre-company signals
        </button>
        {showSignals && (
          <div className="mt-3">
            <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-mid">
              Signals a team member recorded from an authorized public source — a departure announcement, a new
              repository, a filing, a grant, a conference bio, or a profile URL pasted in by hand. These are
              separate from the researched company records above and are never merged into them automatically.
            </p>
            <StealthSignalFeed />
          </div>
        )}
      </section>
    </div>
  );
}
