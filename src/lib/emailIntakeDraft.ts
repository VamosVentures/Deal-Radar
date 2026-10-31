import type { EmailIntakeCandidate } from './api';
import { officialSubcategory } from '../data/taxonomy';

/**
 * The email-intake review card's draft: built from a queued candidate,
 * turned back into the PATCH the server merges. Kept free of React so
 * it can be unit-tested (src/lib/emailIntakeDraft.test.ts).
 */

export type Draft = Record<string, string>;

/** Every founder after the first — not editable on the card, but kept on save. */
export function otherFounders(extracted: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(extracted.founders) ? (extracted.founders as Record<string, unknown>[]).slice(1) : [];
}

function firstFounder(extracted: Record<string, unknown>): { name: string; role: string; background: string } {
  const f = Array.isArray(extracted.founders) ? (extracted.founders as Record<string, unknown>[])[0] : undefined;
  return {
    name: (f?.name as string) ?? '', role: (f?.role as string) ?? '', background: (f?.background as string) ?? '',
  };
}

export function firstEvidence(extracted: Record<string, unknown>): { claim: string; url: string } {
  const e = Array.isArray(extracted.evidence) ? (extracted.evidence as Record<string, unknown>[])[0] : undefined;
  return { claim: (e?.claim as string) ?? '', url: (e?.url as string) ?? '' };
}

export function draftFor(c: EmailIntakeCandidate): Draft {
  const x = c.extracted;
  const traction = (x.traction as { level?: number; note?: string } | undefined) ?? {};
  const founder = firstFounder(x);
  const evidence = firstEvidence(x);
  return {
    name: (x.name as string) ?? '',
    oneLiner: (x.oneLiner as string) ?? '',
    // Claude's proposed vertical when it gave one; otherwise the
    // deterministic classifier's suggestion (see resolveProposedVertical in
    // server/services/emailIntake.ts). Either way the reviewer sees why and
    // confirms it — it is saved only when they Save or Approve.
    vertical: (x.vertical as string) ?? (x.suggestedVertical as string) ?? '',
    // Only an official name of that vertical can be shown or saved.
    subcategory: officialSubcategory((x.vertical as string) ?? (x.suggestedVertical as string), x.subcategory) ?? '',
    stage: (x.stage as string) ?? '',
    city: (x.city as string) ?? '',
    state: (x.state as string) ?? '',
    website: (x.website as string) ?? '',
    foundedYear: x.foundedYear ? String(x.foundedYear) : '',
    teamSize: x.teamSize ? String(x.teamSize) : '',
    tractionLevel: traction.level !== undefined ? String(traction.level) : '',
    tractionNote: traction.note ?? '',
    founderName: founder.name,
    founderRole: founder.role,
    founderBackground: founder.background,
    raising: (x.raising as string) ?? '',
    accelerator: (x.accelerator as string) ?? '',
    evidenceDescription: evidence.url,
  };
}

/** Fill the role/background a founder must have to pass the PATCH schema (server/services/imports.ts). */
function withFounderDefaults(f: Record<string, unknown>): Record<string, unknown> {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const background = text(f.background);
  return {
    ...f,
    name: text(f.name),
    role: text(f.role) || 'Founder',
    background: background.length >= 3 ? background : 'Not on record.',
  };
}

/** Build the PATCH body from a draft — only nested groups that have SOMETHING filled in are sent. */
export function patchFrom(draft: Draft, existing: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (field: string, value: string) => { if (value.trim()) patch[field] = value.trim(); };
  set('name', draft.name);
  set('oneLiner', draft.oneLiner);
  if (draft.vertical) patch.vertical = draft.vertical;
  set('subcategory', draft.subcategory);
  if (draft.stage) patch.stage = draft.stage;
  set('city', draft.city);
  if (draft.state.trim()) patch.state = draft.state.trim().toUpperCase();
  set('website', draft.website);
  if (draft.foundedYear.trim()) patch.foundedYear = Number(draft.foundedYear);
  if (draft.teamSize.trim()) patch.teamSize = Number(draft.teamSize);
  if (draft.tractionLevel.trim() || draft.tractionNote.trim()) {
    patch.traction = { level: draft.tractionLevel.trim() ? Number(draft.tractionLevel) : 0, note: draft.tractionNote.trim() };
  }
  if (draft.founderName.trim()) {
    // The card edits the first founder only; every other founder Claude
    // found must ride along unchanged. Sending just the edited one used to
    // replace the whole list, so approving silently dropped co-founders.
    // Co-founders get the same defaults as the first founder: Claude often
    // finds only a name and role, and the PATCH schema rejects a founder
    // without a background — which used to fail the save and block approval.
    patch.founders = [
      withFounderDefaults({ name: draft.founderName, role: draft.founderRole, background: draft.founderBackground }),
      ...otherFounders(existing).map(withFounderDefaults),
    ];
  }
  set('raising', draft.raising);
  set('accelerator', draft.accelerator);
  const existingEvidence = Array.isArray(existing.evidence) ? (existing.evidence as Record<string, unknown>[])[0] : {};
  if (draft.evidenceDescription.trim()) {
    patch.evidence = [{ ...existingEvidence, url: draft.evidenceDescription.trim() }];
  }
  return patch;
}
