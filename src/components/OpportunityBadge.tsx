import type { Opportunity, OpportunityClass, SourceTier } from '../../shared/opportunity';
import type { IssuerQualification, QualificationResult } from '../../shared/qualification';
import { OPPORTUNITY_CLASS_MEANINGS, isLiveDeal } from '../../shared/opportunity';
import { QUALIFICATION_LABELS, REASON_TEXT } from '../../shared/qualification';

/**
 * Making the deal/lead distinction visible.
 *
 * The dashboard used to present every stored company as though it were an
 * investment opportunity. Most were not — they were companies that exist.
 * These badges exist so that difference is the first thing a reviewer
 * sees, not something they have to infer from an evidence trail.
 *
 * Deliberate choice: only genuinely live classifications get an
 * attention-carrying colour. A company lead is styled as neutral
 * information, because that is what it is.
 */

const CLASS_BADGE: Record<OpportunityClass, { label: string; cls: string }> = {
  'verified-current-opportunity': { label: 'Verified Opportunity', cls: 'bg-verde-soft text-verde border-verde/40' },
  'recent-financing-signal': { label: 'Recent Financing', cls: 'bg-verde-soft text-verde border-verde/30' },
  'credible-fundraising-signal': { label: 'Fundraising Signal', cls: 'bg-marigold-soft text-marigold border-marigold/40' },
  'unverified-opportunity': { label: 'Unverified', cls: 'bg-paper text-slate-mid border-line' },
  'company-lead': { label: 'Company Lead', cls: 'bg-paper text-slate-mid border-line' },
};

const chip = 'inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide';

export function OpportunityClassBadge({ classification, title }: { classification: OpportunityClass; title?: string }) {
  const b = CLASS_BADGE[classification];
  return (
    <span className={`${chip} ${b.cls}`} title={title ?? OPPORTUNITY_CLASS_MEANINGS[classification]}>
      {b.label}
    </span>
  );
}

export function TierBadge({ tier }: { tier: SourceTier }) {
  const cls = tier === 1
    ? 'bg-verde-soft text-verde border-verde/30'
    : tier === 2 ? 'bg-marigold-soft text-marigold border-marigold/30'
    : 'bg-paper text-slate-mid border-line';
  const title = tier === 1
    ? 'Tier 1 — regulatory filing, government award, or official directory.'
    : tier === 2 ? 'Tier 2 — reputable secondary reporting.'
    : 'Tier 3 — supporting signal only. Cannot establish an amount, round, or date.';
  return <span className={`${chip} ${cls}`} title={title}>T{tier}</span>;
}

/** A count of INDEPENDENT sources, which is the number that decides qualification. */
export function CorroborationBadge({ count }: { count: number }) {
  const ok = count >= 2;
  return (
    <span
      className={`${chip} ${ok ? 'bg-verde-soft text-verde border-verde/30' : 'bg-alerta-soft text-alerta border-alerta/40'}`}
      title={ok
        ? `${count} independent source families corroborate this record.`
        : `Only ${count} source family. A live opportunity needs at least 2 independent sources — a single filing is not a deal.`}
    >
      {count} src
    </span>
  );
}

export function QualificationBadge({ result }: { result: QualificationResult }) {
  const map: Partial<Record<QualificationResult, string>> = {
    'qualified-operating-company': 'bg-verde-soft text-verde border-verde/30',
    'human-review-required': 'bg-marigold-soft text-marigold border-marigold/40',
    'public-company': 'bg-alerta-soft text-alerta border-alerta/40',
    'investment-fund': 'bg-alerta-soft text-alerta border-alerta/40',
    'spv-or-project-entity': 'bg-alerta-soft text-alerta border-alerta/40',
    'corporate-subsidiary': 'bg-alerta-soft text-alerta border-alerta/40',
    'unverified-foreign-entity': 'bg-alerta-soft text-alerta border-alerta/40',
  };
  const short: Partial<Record<QualificationResult, string>> = {
    'qualified-operating-company': 'Qualified',
    'company-lead-requires-corroboration': 'Needs corroboration',
    'public-company': 'Public company',
    'investment-fund': 'Fund',
    'spv-or-project-entity': 'SPV / project',
    'corporate-subsidiary': 'Subsidiary',
    'unverified-foreign-entity': 'Unverified foreign',
    'insufficient-evidence': 'Insufficient evidence',
    'human-review-required': 'Human Review',
  };
  return (
    <span className={`${chip} ${map[result] ?? 'bg-paper text-slate-mid border-line'}`} title={QUALIFICATION_LABELS[result]}>
      {short[result] ?? QUALIFICATION_LABELS[result]}
    </span>
  );
}

export function DisqualifiedBadge({ reason }: { reason: string }) {
  return (
    <span className={`${chip} bg-alerta-soft text-alerta border-alerta/40`} title={reason}>
      Disqualified
    </span>
  );
}

/**
 * The full row of badges. Order is deliberate: what this record IS, then
 * how well evidenced it is, then any warning that should stop a reviewer.
 */
export function OpportunityBadges({
  opportunity, qualification, quarantined,
}: {
  opportunity?: Opportunity | null;
  qualification?: IssuerQualification | null;
  quarantined?: { reason: string } | null;
}) {
  const corr = qualification?.corroboratingSources.length ?? 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {opportunity
        ? <OpportunityClassBadge classification={opportunity.classification} />
        : <OpportunityClassBadge classification="company-lead" title="Not yet classified. Treated as a lead — never as a deal by omission." />}
      {opportunity && <TierBadge tier={opportunity.primaryTier} />}
      {qualification && <CorroborationBadge count={corr} />}
      {qualification && qualification.result !== 'qualified-operating-company'
        && qualification.result !== 'company-lead-requires-corroboration'
        && <QualificationBadge result={qualification.result} />}
      {qualification?.isPubliclyTraded && (
        <span className={`${chip} bg-alerta-soft text-alerta border-alerta/40`}
          title={`Publicly traded${qualification.ticker ? ` (${qualification.ticker})` : ''}. A Form D filing by a listed company is not a venture deal.`}>
          Public{qualification.ticker ? ` ${qualification.ticker}` : ''}
        </span>
      )}
      {qualification?.isFundOrSpv && (
        <span className={`${chip} bg-alerta-soft text-alerta border-alerta/40`} title="Fund, SPV, or project vehicle — not an operating company.">
          Fund/SPV
        </span>
      )}
      {quarantined && <DisqualifiedBadge reason={quarantined.reason} />}
    </span>
  );
}

/**
 * Why this record qualified or failed. Shown on the detail view, because
 * a verdict a reviewer cannot interrogate is a verdict they cannot trust.
 */
export function QualificationExplainer({
  opportunity, qualification, quarantined,
}: {
  opportunity?: Opportunity | null;
  qualification?: IssuerQualification | null;
  quarantined?: { reason: string; at: string } | null;
}) {
  if (!opportunity && !qualification) {
    return (
      <p className="text-[11px] leading-relaxed text-slate-mid">
        This company has not been classified yet, so it is treated as a lead. Nothing is assumed to be a deal by omission.
      </p>
    );
  }
  const live = opportunity ? isLiveDeal(opportunity.classification) : false;
  return (
    <div className="space-y-2 text-[11px] leading-relaxed">
      {quarantined && (
        <div className="rounded-[2px] border border-alerta/40 bg-alerta-soft px-2 py-1.5 text-alerta">
          <span className="font-semibold">Disqualified and quarantined.</span> {quarantined.reason}
          <div className="mt-0.5 font-mono text-[10px] opacity-80">
            Kept on record with its evidence for audit — not deleted, and not shown as a live opportunity.
          </div>
        </div>
      )}

      {opportunity && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            {live ? 'Why this is a current signal' : 'Why this is not a live deal'}
          </div>
          <p className="text-slate-mid">{opportunity.whyCurrent}</p>
        </div>
      )}

      {qualification && qualification.reasonCodes.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Qualification reasons</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-mid">
            {qualification.reasonCodes.map((c) => <li key={c}>{REASON_TEXT[c] ?? c}</li>)}
          </ul>
        </div>
      )}

      {qualification && qualification.corroboratingSources.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            Independent sources ({qualification.corroboratingSources.length})
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {qualification.corroboratingSources.map((s) => (
              <li key={s.url}>
                <span className="font-mono text-[10px] uppercase text-slate-mid">{s.family}</span>{' '}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-marigold underline decoration-dotted">
                  {s.sourceId}
                </a>
                {s.publishedAt ? <span className="text-slate-mid"> · {s.publishedAt}</span> : <span className="text-slate-mid"> · undated</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {opportunity && opportunity.conflicts.length > 0 && (
        <div className="rounded-[2px] border border-marigold/40 bg-marigold-soft px-2 py-1.5 text-marigold">
          <span className="font-semibold">Conflicting evidence.</span>
          <ul className="mt-0.5 list-disc pl-4">
            {opportunity.conflicts.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      )}

      {qualification && qualification.fieldsRequiringHumanReview.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Needs a human</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-mid">
            {qualification.fieldsRequiringHumanReview.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      {opportunity && opportunity.missingInformation.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Missing information</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-mid">
            {opportunity.missingInformation.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Evidence header: source, tier, date, amount, round — with the link. */
export function EvidenceSummary({ opportunity }: { opportunity: Opportunity }) {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">Primary evidence</span>
        <TierBadge tier={opportunity.primaryTier} />
        <span className="font-mono text-[10px] text-slate-mid">{opportunity.primarySourceId}</span>
        <span className="font-mono text-[10px] text-slate-mid">
          {opportunity.evidencePublishedAt ?? 'undated — cannot establish currency'}
        </span>
      </div>
      <p className="text-slate-mid">{opportunity.evidenceSummary}</p>
      <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-slate-mid">
        <span>
          Amount:{' '}
          {opportunity.amountText
            ? <span className="text-ink">{opportunity.amountText}</span>
            : <span title="The source did not state an amount. Never inferred.">not stated</span>}
        </span>
        <span>
          Round:{' '}
          {opportunity.roundType
            ? <span className="text-ink">{opportunity.roundType}</span>
            : <span title="The source did not state a round type. Never inferred.">not stated</span>}
        </span>
        <span>Evidence confidence: {Math.round(opportunity.evidenceConfidence * 100)}%</span>
      </div>
      <a href={opportunity.evidenceUrl} target="_blank" rel="noreferrer"
        className="inline-block break-all text-marigold underline decoration-dotted">
        {opportunity.evidenceUrl}
      </a>
    </div>
  );
}
