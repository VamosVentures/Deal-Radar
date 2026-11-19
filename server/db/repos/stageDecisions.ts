import { getDb } from '../client';

/**
 * The team's call on a company, recorded when it is added to HubSpot: the
 * HubSpot stage and, for a Passed/Revisit stage, the pass/revisit reason
 * and context. See migration 28. This is the label the "learn from
 * reviews" work reads — "synced to HubSpot" is not, because every company
 * is synced, fit or not.
 */
export interface StageDecision {
  companyId: string;
  hubspotStage: string;
  passReason: string | null;
  passNotes: string | null;
  decidedBy: string | null;
  decidedAt: string;
}

/**
 * Record a decision. Silently skipped for an id that is not a company on
 * record (e.g. a Stealth Radar person synced through the same popup) —
 * the HubSpot sync has already succeeded and must not fail over this.
 */
export function recordStageDecision(d: Omit<StageDecision, 'decidedAt'> & { decidedAt?: string }): boolean {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM companies WHERE id = ?').get(d.companyId);
  if (!exists) return false;
  db.prepare(`INSERT INTO company_stage_decisions (company_id, hubspot_stage, pass_reason, pass_notes, decided_by, decided_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    d.companyId, d.hubspotStage, d.passReason, d.passNotes || null, d.decidedBy, d.decidedAt ?? new Date().toISOString(),
  );
  return true;
}

/** Every decision for one company, oldest first. */
export function stageDecisionsFor(companyId: string): StageDecision[] {
  return (getDb().prepare(`SELECT company_id, hubspot_stage, pass_reason, pass_notes, decided_by, decided_at
    FROM company_stage_decisions WHERE company_id = ? ORDER BY decided_at, id`).all(companyId) as {
    company_id: string; hubspot_stage: string; pass_reason: string | null; pass_notes: string | null; decided_by: string | null; decided_at: string;
  }[]).map((r) => ({
    companyId: r.company_id, hubspotStage: r.hubspot_stage, passReason: r.pass_reason,
    passNotes: r.pass_notes, decidedBy: r.decided_by, decidedAt: r.decided_at,
  }));
}
