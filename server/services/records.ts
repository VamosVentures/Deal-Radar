import { store } from '../lib/store';
import type {
  FollowUpTask,
  OutreachActivity,
  OutreachRecord,
  OutreachStatus,
} from '../../shared/integrations';

/** Server-side outreach tracker — one record per company. */

export function getRecords(): OutreachRecord[] {
  return Object.values(store.raw.outreach);
}

export function upsertRecord(
  seed: Pick<
    OutreachRecord,
    | 'companyId' | 'companyName' | 'founderName' | 'founderEmail' | 'owner'
    | 'vertical' | 'companyStage' | 'fitScore' | 'policyException' | 'sourceQuality'
  >,
  patch: Partial<OutreachRecord> = {},
): OutreachRecord {
  const existing = store.raw.outreach[seed.companyId];
  const record: OutreachRecord = existing
    ? { ...existing, ...seed, ...patch }
    : {
        hubspotStatus: 'Not added',
        hubspotCompanyId: null,
        hubspotUrl: null,
        outreachStatus: 'Not Reviewed',
        draftCreatedAt: null,
        draftSubject: null,
        outlookDraftId: null,
        outlookWebLink: null,
        emailSentAt: null,
        lastResponseAt: null,
        meetingStatus: 'None',
        followUp: null,
        nextAction: 'Review evidence',
        activities: [],
        ...seed,
        ...patch,
      };
  store.raw.outreach[seed.companyId] = record;
  store.save();
  return record;
}

export function patchRecord(companyId: string, patch: Partial<OutreachRecord>): OutreachRecord {
  const existing = store.raw.outreach[companyId];
  if (!existing) {
    throw Object.assign(new Error(`No outreach record exists for ${companyId} yet.`), { status: 404 });
  }
  const record = { ...existing, ...patch };
  store.raw.outreach[companyId] = record;
  store.save();
  return record;
}

export function addActivity(
  companyId: string,
  kind: OutreachActivity['kind'],
  detail: string,
  actor: string,
  hubspotNoteId: string | null = null,
): OutreachActivity {
  const record = store.raw.outreach[companyId];
  if (!record) {
    throw Object.assign(new Error(`No outreach record exists for ${companyId} yet.`), { status: 404 });
  }
  const activity: OutreachActivity = {
    id: store.nextId('act'),
    companyId,
    kind,
    detail,
    actor,
    at: new Date().toISOString(),
    hubspotNoteId,
  };
  record.activities.unshift(activity);
  store.save();
  return activity;
}

export function setFollowUp(companyId: string, dueDate: string, note: string): FollowUpTask {
  const task: FollowUpTask = { companyId, dueDate, note, done: false };
  const record = store.raw.outreach[companyId];
  if (!record) {
    throw Object.assign(new Error(`No outreach record exists for ${companyId} yet.`), { status: 404 });
  }
  record.followUp = task;
  store.raw.followUps = [
    ...store.raw.followUps.filter((f) => f.companyId !== companyId),
    task,
  ];
  store.save();
  return task;
}

export interface FollowUpSummary {
  dueToday: OutreachRecord[];
  overdue: OutreachRecord[];
  dueThisWeek: OutreachRecord[];
  draftsNeverSent: OutreachRecord[];
}

export function followUpSummary(today = new Date()): FollowUpSummary {
  const records = getRecords();
  const d0 = today.toISOString().slice(0, 10);
  const weekEnd = new Date(today.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  const withDue = records.filter((r) => r.followUp && !r.followUp.done);
  return {
    dueToday: withDue.filter((r) => r.followUp!.dueDate === d0),
    overdue: withDue.filter((r) => r.followUp!.dueDate < d0),
    dueThisWeek: withDue.filter((r) => r.followUp!.dueDate > d0 && r.followUp!.dueDate <= weekEnd),
    draftsNeverSent: records.filter(
      (r) => r.outreachStatus === 'Saved to Outlook' && !r.emailSentAt,
    ),
  };
}

export function isValidStatus(s: string): s is OutreachStatus {
  return ([
    'Not Reviewed', 'Approved for Tracking', 'Added to HubSpot', 'Outreach Approved',
    'Draft Generated', 'Saved to Outlook', 'Manually Marked Sent', 'Replied',
    'Meeting Scheduled', 'Follow-Up Needed', 'Monitor', 'Closed',
  ] as string[]).includes(s);
}
