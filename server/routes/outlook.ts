import { Router } from 'express';
import { z } from 'zod';
import { env } from '../env';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { requireAdmin } from '../lib/auth';
import { wrap } from './helpers';
import { outlookService } from '../services/outlook';
import { hubspotServiceIfAvailable } from '../services/hubspot';
import { companyMetaView } from '../db/repos/companies';
import { outreachDraftSchema } from '../../shared/integrations';

/**
 * Outlook: create a reviewable DRAFT, link to it, and record that it
 * was created. Nothing is ever sent automatically and delivery is
 * never simulated — sending happens manually, from Outlook, by a
 * person. There is no send path in this codebase.
 */
export const outlookRouter = Router();

outlookRouter.get('/outlook/status', wrap(async (_req, res) => {
  res.json(await outlookService().status());
}));

outlookRouter.post('/outlook/connect', requireAdmin, wrap(async (_req, res) => {
  res.json(await outlookService().beginConnect());
}));

// Not gated: OAuth redirect target reached by a top-level browser
// navigation from Microsoft, protected by its own state-token check.
outlookRouter.get('/outlook/callback', wrap(async (req, res) => {
  const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
  const { account } = await outlookService().handleCallback(code, state);
  res.redirect(`${env.FRONTEND_URL}/sources?outlook=connected&account=${encodeURIComponent(account)}`);
}));

outlookRouter.post('/outlook/disconnect', requireAdmin, wrap(async (_req, res) => {
  await outlookService().disconnect();
  res.json({ ok: true });
}));

outlookRouter.post('/outlook/drafts', wrap(async (req, res) => {
  const input = z.object({
    companyId: z.string(),
    to: z.string(),
    subject: z.string(),
    body: z.string().min(10),
    senderName: z.string().min(1),
    tone: z.string().default('—'),
  }).parse(req.body);

  const draftResult = await outlookService().createDraft({
    to: input.to, subject: input.subject, body: input.body,
  });

  // Record that a draft was created (id, link, author, time).
  const draft = outreachDraftSchema.parse({
    id: store.nextId('draft'),
    companyId: input.companyId,
    to: input.to,
    subject: input.subject,
    body: input.body,
    senderName: input.senderName,
    tone: input.tone,
    outlookDraftId: draftResult.draftId,
    outlookWebLink: draftResult.webLink,
    demo: draftResult.demo,
    createdAt: new Date().toISOString(),
  });
  store.raw.drafts.push(draft);
  store.save();

  // Note the draft on the linked HubSpot company, when one exists.
  let hubspotNoteId: string | null = null;
  const hubspotCompanyId = companyMetaView()[input.companyId]?.hubspotCompanyId;
  const hubspot = hubspotCompanyId ? hubspotServiceIfAvailable() : null;
  if (hubspotCompanyId && hubspot) {
    const note = await hubspot.logActivity({
      companyRecordId: hubspotCompanyId,
      note: `Outreach draft created by ${input.senderName} — subject: "${input.subject}". Draft is awaiting human review and manual send from Outlook.`,
    }).catch(() => null);
    hubspotNoteId = note?.noteId ?? null;
  }
  audit({
    provider: 'outlook', mode: draftResult.demo ? 'local' : 'live', action: 'draft-recorded',
    subject: input.companyId, outcome: 'ok',
    detail: `Draft "${input.subject.slice(0, 60)}" by ${input.senderName}${hubspotNoteId ? ` (HubSpot note ${hubspotNoteId})` : ''}`,
  });

  res.json({
    ok: true,
    demo: draftResult.demo,
    draftId: draft.id,
    outlookDraftId: draftResult.draftId,
    webLink: draftResult.webLink,
    message: 'Draft saved to Outlook. Open Outlook to review and send it yourself.',
  });
}));

/** Drafts this app created (a record that drafting happened — not a tracker). */
outlookRouter.get('/outlook/drafts', wrap(async (req, res) => {
  const { companyId } = z.object({ companyId: z.string().optional() }).parse(req.query);
  const drafts = store.raw.drafts
    .filter((d) => !companyId || d.companyId === companyId)
    .map(({ body: _body, ...rest }) => rest); // never echo full bodies in lists
  res.json({ drafts });
}));
