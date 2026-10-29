import { audit } from '../lib/guard';
import { companyMetaView, getCompany, removeCompany, type RemovedCompany } from '../db/repos/companies';

/**
 * Deleting a company on purpose — e.g. one that is acquired or late-stage
 * and was never a Vamos target (WePay, Paystack, … on 2026-10-28).
 *
 * The company and everything recorded on it (founders, evidence, scores)
 * is deleted, and its identity goes on the removed list so automated
 * sourcing (discovery, funding news, investor news) never re-adds it. A
 * person can still add it back deliberately through email intake or a CSV.
 * Take a database backup first when removing in bulk; this cannot be
 * undone from the app.
 */
export function deleteCompany(
  id: string,
  actor: string,
  reason: string | null,
): { ok: true; removed: RemovedCompany } | { ok: false; status: number; error: string } {
  if (!getCompany(id)) return { ok: false, status: 404, error: `No company with id ${id}.` };
  if (companyMetaView()[id]?.reviewStatus === 'Synced to HubSpot') {
    return {
      ok: false, status: 409,
      error: 'This company is already synced to HubSpot. Deleting it here would leave the CRM record orphaned — remove it in HubSpot first if that is intended.',
    };
  }
  const removed = removeCompany(id, actor, reason);
  if (!removed) return { ok: false, status: 404, error: `No company with id ${id}.` };
  audit({
    provider: 'system', mode: 'local', action: 'company-removed', subject: id,
    outcome: 'ok', detail: `${removed.name} deleted by ${actor}${reason ? ` — ${reason}` : ''}. Blocked from automated re-sourcing.`,
  });
  return { ok: true, removed };
}
