import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { env } from '../env';
import { setConfig } from '../db/repos/operations';
import { createApp } from '../app';
import { adminAgent } from './testAuth';
import { isJobDue, jobsView, listJobs, nextRunAt, saveJob, tickScheduler, updateJobTiming } from '../services/schedule';
import { discoveryRuns } from '../services/discovery';
import { installFixtureSources, uninstallFixtureSources } from './fixtures/sources';
import { scheduledJobSchema, type ScheduledJob } from '../../shared/discovery';
import { formatInZone, latestSlot, nextSlot } from '../../shared/scheduleTime';

/**
 * Scheduled sourcing runs on a day and time (Andrew, 2026-11-19: "Sunday
 * evenings", chosen as 6:00 PM Central). Before, a schedule had no day or
 * time — next run = last run + 7 days, checked hourly — so it drifted later
 * each week and a deploy or "Run sourcing now" moved it.
 */

const t = (iso: string) => new Date(iso).getTime();
const SUNDAY_6PM_CENTRAL = { runDay: 0, runTime: '18:00', timeZone: 'America/Chicago' } as const;

/** A schedule as production stores it today: saved before day/time existed. */
const LEGACY_STORED = {
  id: 'job-1', cadence: 'weekly', jobType: 'incremental-sourcing', enabled: true,
  query: { sources: ['yc'], vertical: 'fintech' }, lastRunAt: '2026-11-17T03:48:00.000Z', lastError: null,
};

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

describe('wall-clock slots', () => {
  it('Sunday 6:00 PM Central is midnight UTC in winter and 11 PM UTC in summer', () => {
    // Thursday 2026-11-19, noon UTC: last slot Sun Nov 15, next Sun Nov 22.
    expect(new Date(latestSlot(t('2026-11-19T12:00:00Z'), SUNDAY_6PM_CENTRAL)).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(nextSlot(t('2026-11-19T12:00:00Z'), SUNDAY_6PM_CENTRAL)).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(new Date(nextSlot(t('2026-07-01T12:00:00Z'), SUNDAY_6PM_CENTRAL)).toISOString()).toBe('2026-07-05T23:00:00.000Z');
  });

  it('lands on the right hour on the Sundays daylight saving changes', () => {
    // DST ends Sunday 2026-11-01 (CST from 2 AM): 6 PM CST = 00:00Z Monday.
    expect(new Date(nextSlot(t('2026-10-31T12:00:00Z'), SUNDAY_6PM_CENTRAL)).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    // DST starts Sunday 2026-03-08 (CDT from 2 AM): 6 PM CDT = 23:00Z.
    expect(new Date(nextSlot(t('2026-03-07T12:00:00Z'), SUNDAY_6PM_CENTRAL)).toISOString()).toBe('2026-03-08T23:00:00.000Z');
  });

  it('a slot exactly now is the latest slot, not the next one', () => {
    const at = t('2026-11-23T00:00:00Z');
    expect(latestSlot(at, SUNDAY_6PM_CENTRAL)).toBe(at);
    expect(nextSlot(at, SUNDAY_6PM_CENTRAL)).toBe(t('2026-11-30T00:00:00Z'));
  });

  it('shows times in the schedule\'s own time zone', () => {
    expect(formatInZone('2026-11-23T00:00:00.000Z', 'America/Chicago')).toBe('Sun, Nov 22, 6:00 PM Central');
  });
});

describe('when a schedule is due', () => {
  it('schedules saved before day/time existed take Sunday 6:00 PM Central', () => {
    const job = scheduledJobSchema.parse(LEGACY_STORED);
    expect(job).toMatchObject({ ...SUNDAY_6PM_CENTRAL, createdAt: null });
  });

  it('the production schedules (last run Mon Nov 16, 9:48 PM Central) are not run again on deploy, and next run Sun Nov 22 at 6:00 PM', () => {
    const job = scheduledJobSchema.parse(LEGACY_STORED);
    expect(isJobDue(job, t('2026-11-20T15:00:00Z'))).toBe(false);
    expect(nextRunAt(job, t('2026-11-20T15:00:00Z'))).toBe('2026-11-23T00:00:00.000Z');
    expect(isJobDue(job, t('2026-11-22T23:59:00Z'))).toBe(false); // 5:59 PM Central
    expect(isJobDue(job, t('2026-11-23T00:00:00Z'))).toBe(true); // 6:00 PM Central
  });

  it('once it has run after the slot, it waits for next Sunday — no drift', () => {
    const job: ScheduledJob = { ...scheduledJobSchema.parse(LEGACY_STORED), lastRunAt: '2026-11-23T00:21:00.000Z' };
    expect(isJobDue(job, t('2026-11-29T23:59:00Z'))).toBe(false);
    expect(isJobDue(job, t('2026-11-30T00:00:00Z'))).toBe(true);
  });

  it('a "Run sourcing now" during the week does not move the Sunday slot', () => {
    const job: ScheduledJob = { ...scheduledJobSchema.parse(LEGACY_STORED), lastRunAt: '2026-11-26T16:00:00.000Z' }; // Thursday Nov 26
    expect(nextRunAt(job, t('2026-11-26T17:00:00Z'))).toBe('2026-11-30T00:00:00.000Z');
  });

  it('a new schedule waits for its first slot instead of running the moment it is saved', () => {
    const job: ScheduledJob = { ...scheduledJobSchema.parse({ ...LEGACY_STORED, lastRunAt: null }), createdAt: '2026-11-19T15:00:00.000Z' };
    expect(isJobDue(job, t('2026-11-19T15:15:00Z'))).toBe(false);
    expect(isJobDue(job, t('2026-11-23T00:00:00Z'))).toBe(true);
  });

  it('a slot missed while the server was down runs at the first check after it is back', () => {
    const job = scheduledJobSchema.parse(LEGACY_STORED);
    expect(isJobDue(job, t('2026-11-24T14:00:00Z'))).toBe(true); // Tuesday Nov 24
  });

  it('a biweekly schedule skips the Sunday right after a run', () => {
    const job: ScheduledJob = { ...scheduledJobSchema.parse({ ...LEGACY_STORED, cadence: 'biweekly' }), lastRunAt: '2026-11-23T00:05:00.000Z' };
    expect(isJobDue(job, t('2026-11-30T00:00:00Z'))).toBe(false);
    expect(nextRunAt(job, t('2026-11-24T00:00:00Z'))).toBe('2026-12-07T00:00:00.000Z');
    expect(isJobDue(job, t('2026-12-07T00:00:00Z'))).toBe(true);
  });
});

describe('changing a saved schedule\'s day/time', () => {
  it('changes only when it runs — sources, filters and last run stay', () => {
    setConfig('scheduled-jobs', [LEGACY_STORED]);
    const before = listJobs()[0];
    const updated = updateJobTiming('job-1', { runDay: 1, runTime: '07:30', timeZone: 'America/New_York' });
    expect(updated).toMatchObject({ runDay: 1, runTime: '07:30', timeZone: 'America/New_York' });
    expect(listJobs()[0]).toEqual({ ...before, runDay: 1, runTime: '07:30', timeZone: 'America/New_York' });
  });

  it('refuses a time off the quarter hour, an unknown time zone, or an unknown schedule', () => {
    setConfig('scheduled-jobs', [LEGACY_STORED]);
    expect(() => updateJobTiming('job-1', { ...SUNDAY_6PM_CENTRAL, runTime: '18:10' })).toThrow();
    expect(() => updateJobTiming('job-1', { ...SUNDAY_6PM_CENTRAL, timeZone: 'Europe/London' })).toThrow();
    expect(() => updateJobTiming('nope', SUNDAY_6PM_CENTRAL)).toThrow(/not found/);
  });

  it('is an administrator action over HTTP, and Settings gets the next run time', async () => {
    setConfig('scheduled-jobs', [LEGACY_STORED]);
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.patch('/api/schedule/job-1').send({ runDay: 0, runTime: '18:30', timeZone: 'America/Chicago' });
    expect(res.status).toBe(200);
    expect(res.body.runTime).toBe('18:30');
    const list = await agent.get('/api/schedule');
    expect(list.body.jobs[0].nextRunAt).toMatch(/T(00|23):30:00\.000Z$/);
    expect(jobsView(t('2026-11-20T15:00:00Z'))[0].nextRunAt).toBe('2026-11-23T00:30:00.000Z');
  });

  it('the job keeps the key it is stored under', () => {
    // Guard: the tests above write 'scheduled-jobs' directly; if the
    // storage key ever changes they would silently test an empty list.
    saveJob({ cadence: 'weekly', jobType: 'incremental-sourcing', query: { sources: ['yc'] }, enabled: true });
    expect(listJobs()).toHaveLength(1);
    expect(listJobs()[0].createdAt).toBeTruthy();
  });
});

describe('the scheduler tick follows the slot', () => {
  beforeEach(() => { installFixtureSources(); env.RUN_SCHEDULER = 'true'; });
  afterEach(() => { uninstallFixtureSources(); env.RUN_SCHEDULER = 'false'; });

  it('does nothing before Sunday 6:00 PM Central, runs at it, and not again that week', async () => {
    setConfig('scheduled-jobs', [LEGACY_STORED]);
    expect(await tickScheduler(t('2026-11-22T23:45:00Z'))).toBe(0);
    expect(discoveryRuns()).toHaveLength(0);
    expect(await tickScheduler(t('2026-11-23T00:00:00Z'))).toBe(1);
    expect(listJobs()[0].lastRunAt).toBe('2026-11-23T00:00:00.000Z');
    expect(await tickScheduler(t('2026-11-23T00:15:00Z'))).toBe(0);
  });
});
