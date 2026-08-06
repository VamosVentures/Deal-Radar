import { getDb } from '../db/client';
import { audit } from '../lib/guard';
import type { TractionState } from '../../shared/traction';
import type { YcProfile } from '../enrichment/ycProfile';

/**
 * Claims an extractor found that a PERSON must decide on.
 *
 * The rule this enforces: reading a claim is not the same as believing
 * it. The YC profile parser can now pull "20 departments across 16
 * hospitals" off a public page — cited, verbatim, real. It is still the
 * company describing itself, and turning it into 7/10 traction without a
 * human in the loop is exactly the kind of laundering this codebase
 * exists to prevent.
 *
 * So extraction ends here. Nothing in `pending_evidence` touches a score
 * while it is pending; a score changes only when an analyst accepts a
 * claim through the normal traction-review path, which audits itself.
 */

export type PendingKind = 'traction' | 'stage';
export type PendingStatus = 'pending' | 'accepted' | 'rejected' | 'edited';

export interface PendingEvidence {
  id: number;
  companyId: string;
  kind: PendingKind;
  quote: string;
  sourceUrl: string;
  sourceFamily: string;
  section: string;
  aboutThisCompany: boolean;
  /** Anything an accelerator hosts for a company is company-claimed. */
  provenance: 'company-claimed' | 'independently-confirmed';
  suggestedState: string | null;
  suggestionBasis: string | null;
  /**
   * The excerpt an analyst corrected before accepting. `quote` always
   * keeps what the source published, so a second reviewer can see both
   * the original claim and what the first reviewer changed it to.
   */
  editedQuote: string | null;
  publishedAt: string | null;
  accessedAt: string;
  status: PendingStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  at: string;
}

/**
 * Map a company-authored claim onto the traction state it SUGGESTS.
 *
 * Deliberately conservative and deliberately non-binding. The analyst
 * sees the suggestion next to the quote and accepts, edits or rejects
 * it; nothing here is applied. Ordered strongest-first so the most
 * specific evidence wins.
 */
function suggestTractionState(quote: string): { state: TractionState; basis: string } | null {
  const q = quote.toLowerCase();
  const rules: { test: RegExp; state: TractionState; basis: string }[] = [
    { test: /\b(?:\d[\d,.]*\+?\s*(?:paying )?customers|across \d+\s*(?:hospitals|health systems|sites|clinics|dealerships))\b/, state: 'multiple-deployments', basis: 'names more than one customer or site' },
    { test: /\b(?:ARR|MRR|recurring revenue|subscription revenue)\b/i, state: 'recurring-revenue', basis: 'names recurring revenue' },
    { test: /\b(?:payment volume|processed|processing|GMV|transactions? (?:per|a) (?:day|month))\b/, state: 'named-customer', basis: 'names commercial volume flowing through the product' },
    { test: /\b(?:our clients|our customers|customers include|live with|in production (?:at|with))\b/, state: 'named-customer', basis: 'refers to customers in production' },
    { test: /\bpaid pilot|paying pilot\b/, state: 'paid-pilot', basis: 'names a paid pilot' },
    { test: /\bdesign partners?\b/, state: 'design-partner', basis: 'names design partners' },
    { test: /\bpilot(?:s|ing)?\b|\bonboard(?:ed|ing)\b|\btrial\b/, state: 'pilot', basis: 'names a pilot or onboarding' },
    { test: /\bcontracts?\b|\bLOIs?\b|\bletters of intent\b/, state: 'pilot', basis: 'names a contract or letter of intent' },
    { test: /\bintegrat(?:ed|ion|ions)\b/, state: 'design-partner', basis: 'names shipped integrations' },
    { test: /\bwaitlist\b|\bcoming soon\b|\bwill launch\b/, state: 'pre-launch', basis: 'describes something not yet live' },
  ];
  const hit = rules.find((r) => r.test.test(q));
  return hit ? { state: hit.state, basis: hit.basis } : null;
}

function rowToPending(r: Record<string, unknown>): PendingEvidence {
  return {
    id: r.id as number,
    companyId: r.company_id as string,
    kind: r.kind as PendingKind,
    quote: r.quote as string,
    sourceUrl: r.source_url as string,
    sourceFamily: r.source_family as string,
    section: r.section as string,
    aboutThisCompany: (r.about_this_company as number) === 1,
    provenance: r.provenance as PendingEvidence['provenance'],
    suggestedState: (r.suggested_state as string | null) ?? null,
    suggestionBasis: (r.suggestion_basis as string | null) ?? null,
    editedQuote: (r.edited_quote as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
    accessedAt: r.accessed_at as string,
    status: r.status as PendingStatus,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    at: r.at as string,
  };
}

export function listPendingEvidence(companyId: string, kind?: PendingKind): PendingEvidence[] {
  const sql = `SELECT * FROM pending_evidence WHERE company_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY status = 'pending' DESC, id DESC`;
  const rows = (kind
    ? getDb().prepare(sql).all(companyId, kind)
    : getDb().prepare(sql).all(companyId)) as Record<string, unknown>[];
  return rows.map(rowToPending);
}

export interface RecordedPending {
  inserted: number;
  skippedDuplicate: number;
  /**
   * Items filed as NOT about this company (founder biography, or a
   * prior-company beat inside a launch post).
   *
   * These are recorded, not discarded. An analyst has to be able to see
   * that "we helped onboard 30M+ users" exists on the page AND that it
   * describes a company the founders no longer run — deleting it leaves
   * them re-reading the source to find out why a number they remember is
   * missing. What they never get is a traction suggestion for it.
   */
  notAboutCompany: number;
}

/**
 * Turn a parsed YC profile into pending claims.
 *
 * Two filters matter here and both are about not misattributing:
 *
 *  - A claim from a founder BIOGRAPHY is dropped from the traction
 *    queue. "At my last company, I managed $10M+ in contractor payouts"
 *    is Grade's founder describing a PREVIOUS company; filing it as
 *    Grade's traction would be a false statement about Grade. It is
 *    founder-market-fit evidence and already reaches the score that way,
 *    through the founder biography on the founder component.
 *  - Everything YC hosts is `company-claimed`. A credible accelerator
 *    publishing a company's own words is not an independent third party
 *    confirming them.
 */
export function recordYcPendingEvidence(
  companyId: string,
  profile: YcProfile,
  opts: { accessedAt: string; actor?: string } ,
): RecordedPending {
  const db = getDb();
  const at = new Date().toISOString();
  let inserted = 0;
  let skippedDuplicate = 0;
  let notAboutCompany = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO pending_evidence
      (company_id, kind, quote, source_url, source_family, section, about_this_company,
       provenance, suggested_state, suggestion_basis, published_at, accessed_at, status, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const changed = () => (db.prepare('SELECT changes() AS n').get() as { n: number }).n;

  for (const claim of profile.tractionClaims) {
    /**
     * A claim that is not about this company gets NO suggested state.
     *
     * This is the whole safeguard in one line. The suggestion is the only
     * part of a pending row that can travel into a score, so withholding
     * it means a founder's prior-company number can be read, opened and
     * cited by an analyst but can never be one accepted click away from
     * becoming this company's traction rating.
     */
    if (!claim.aboutThisCompany) notAboutCompany += 1;
    const suggestion = claim.aboutThisCompany ? suggestTractionState(claim.quote) : null;
    const basis = claim.aboutThisCompany
      ? suggestion?.basis ?? null
      : claim.section === 'founder-bio'
        ? 'Founder biography — describes a person’s background, most often at a PRIOR company. '
          + 'Founder-market-fit evidence, not this company’s traction. No traction state is suggested.'
        : 'Prior-company narrative inside the launch post (e.g. an "Our Story"/"Before <company>" beat). '
          + 'Describes a company the founders no longer run. No traction state is suggested.';
    insert.run(
      companyId, 'traction', claim.quote, profile.canonicalUrl, 'accelerator', claim.section,
      claim.aboutThisCompany ? 1 : 0,
      'company-claimed', suggestion?.state ?? null, basis, null, opts.accessedAt, at,
    );
    if (changed() > 0) inserted += 1; else skippedDuplicate += 1;
  }

  /**
   * Stage. YC batch + Active status is a cited FACT, and it is NOT a
   * financing round — a company can be in a current batch with no priced
   * round at all.
   *
   * The existing rubric does contain a bucket that fits
   * ("Early-stage — round not publicly disclosed", 9/15, documented in
   * src/lib/scoring.ts as "researched as early-stage with the specific
   * round undisclosed"). It is NOT applied automatically here, because
   * automatic application of exactly that label is what put Brex (YC
   * W17) and Deel (W19) into the pipeline as early-stage companies
   * scoring 7.3. A current batch is the honest case for it; a decade-old
   * batch is not, and only a person should draw that line.
   */
  if (profile.batch && /active/i.test(profile.status ?? '')) {
    const quote = `Batch: ${profile.batch}. Status: ${profile.status}.`
      + (profile.foundedYear ? ` Founded: ${profile.foundedYear}.` : '')
      + (profile.location ? ` Location: ${profile.location}.` : '');
    insert.run(
      companyId, 'stage', quote, profile.canonicalUrl, 'accelerator', 'sidebar-card', 1,
      'company-claimed', 'Early-stage — round not publicly disclosed',
      `Current accelerator cohort (${profile.batch}), status ${profile.status}. `
      + 'INFERENCE, not a stated round: YC participation is not a financing event. '
      + 'The rubric bucket "Early-stage — round not publicly disclosed" fits a CURRENT cohort, '
      + 'but it is not applied automatically — auto-applying it is what previously labelled '
      + 'decade-old alumni as early-stage. Confirm the batch is current before accepting.',
      null, opts.accessedAt, at,
    );
    if (changed() > 0) inserted += 1; else skippedDuplicate += 1;
  }

  if (inserted > 0) {
    audit({
      provider: 'system', mode: 'local', action: 'pending-evidence-recorded',
      subject: companyId, outcome: 'ok',
      detail: `${inserted} company-claimed item(s) from ${profile.canonicalUrl} queued for analyst review `
        + `(${notAboutCompany} of them flagged as NOT about this company — founder biography or a prior-company `
        + 'beat in the launch post — and carrying no suggested traction state). Nothing was scored.',
    });
  }
  return { inserted, skippedDuplicate, notAboutCompany };
}

export interface PendingDecision {
  id: number;
  status: Exclude<PendingStatus, 'pending'>;
  actor: string;
  note?: string | null;
  /**
   * The corrected excerpt, for `status: 'edited'`. Never replaces
   * `quote` — see migration 20.
   */
  editedQuote?: string | null;
}

/**
 * Record accept / edit / reject.
 *
 * Accepting here marks the CLAIM reviewed; it does not by itself write a
 * traction rating. The analyst still submits the traction review, which
 * carries its own validation (a scoring state needs a source URL or a
 * substantive note) and appends its own scoring row. Two steps on
 * purpose: agreeing that a company said something is not the same as
 * deciding what it is worth.
 */
export function decidePendingEvidence(d: PendingDecision): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare('SELECT id, status, decided_by, decided_at FROM pending_evidence WHERE id = ?').get(d.id) as
    { id: number; status: string; decided_by: string | null; decided_at: string | null } | undefined;
  if (!row) return { ok: false, error: `No pending evidence with id ${d.id}.` };

  /**
   * A decision is not silently overwritable.
   *
   * Migration 19 states this table is "append-only in the same sense as
   * traction_reviews", and it was not: a second call simply overwrote
   * `decided_by` / `decided_at` / `decision_note`, so the first
   * reviewer's decision survived only in the audit log — which is a
   * 500-entry ring buffer (server/lib/guard.ts) that evicts older
   * entries. "Review actions must be auditable" cannot rest on a store
   * that forgets.
   *
   * Refusing the overwrite keeps the first decision as the record and
   * makes the conflict visible, instead of resolving it by last-write-wins.
   */
  if (row.status !== 'pending') {
    return {
      ok: false,
      error: `Pending evidence ${d.id} was already ${row.status}`
        + `${row.decided_by ? ` by "${row.decided_by}"` : ''}${row.decided_at ? ` on ${row.decided_at}` : ''}. `
        + 'A recorded decision is not overwritten — record a new traction review if the conclusion has changed.',
    };
  }

  if (d.status === 'edited' && !d.editedQuote?.trim()) {
    return {
      ok: false,
      error: 'An edited decision must include the corrected excerpt. '
        + 'Marking an item "edited" without it records a change nobody can see.',
    };
  }

  db.prepare(`
    UPDATE pending_evidence
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, edited_quote = ?
    WHERE id = ?
  `).run(d.status, d.actor, new Date().toISOString(), d.note ?? null, d.editedQuote?.trim() ?? null, d.id);
  audit({
    provider: 'system', mode: 'local', action: 'pending-evidence-decision',
    subject: String(d.id), outcome: 'ok',
    detail: `Pending evidence ${d.id}: ${row.status} → ${d.status} by "${d.actor}" `
      + '(unauthenticated actor string, not a verified identity). No score changed by this action alone.'
      + (d.editedQuote ? ' The original published quote is retained unchanged alongside the edit.' : ''),
  });
  return { ok: true };
}
