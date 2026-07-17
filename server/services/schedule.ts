import { z } from 'zod';
import { schedulerEnabled } from '../env';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { scheduledJobSchema, type ScheduledJob } from '../../shared/discovery';
import { runDiscovery } from './discovery';

/**
 * Scheduled sourcing. Schedules are ALWAYS storable as configuration;
 * they EXECUTE only when RUN_SCHEDULER=true on a continuously hosted
 * backend. When inactive, the UI shows "Configured but inactive" and
 * nothing pretends jobs will run. Scheduled runs reuse the discovery
 * pipeline — same budgets, same guardrails, and the same hard rule:
 * they never contact founders, send email, approve/reject deals, or
 * change HubSpot stages. Discovered candidates wait for human review
 * exactly like manual runs.
 */

export function listJobs(): ScheduledJob[] {
  return z.array(scheduledJobSchema).catch([]).parse(store.raw.scheduledJobs);
}

export function schedulerStatus(): { active: boolean; label: string } {
  const active = schedulerEnabled();
  return {
    active,
    label: active
      ? 'Scheduler active — enabled jobs run on cadence.'
      : 'Configured but inactive — RUN_SCHEDULER=false, so schedules are stored configuration only. No job will run automatically.',
  };
}

export function saveJob(raw: unknown): ScheduledJob {
  const input = scheduledJobSchema.omit({ id: true, lastRunAt: true }).parse(raw);
  const jobs = listJobs();
  const job: ScheduledJob = { ...input, id: store.nextId('job'), lastRunAt: null };
  store.raw.scheduledJobs = [...jobs, job];
  store.save();
  audit({
    provider: 'system', mode: 'mock', action: 'schedule-save', subject: job.id, outcome: 'ok',
    detail: `${job.cadence} ${job.jobType} — ${schedulerEnabled() ? 'scheduler active' : 'Configured but inactive (RUN_SCHEDULER=false)'}`,
  });
  return job;
}

export function deleteJob(id: string): void {
  store.raw.scheduledJobs = listJobs().filter((j) => j.id !== id);
  store.save();
}

// ── Execution loop (only started when RUN_SCHEDULER=true) ────────

const CADENCE_MS = { weekly: 7 * 24 * 3600_000, biweekly: 14 * 24 * 3600_000 } as const;
let running = false; // duplicate-run protection within this process
let timer: ReturnType<typeof setInterval> | null = null;

export async function tickScheduler(now = Date.now()): Promise<number> {
  if (!schedulerEnabled() || running) return 0;
  running = true;
  let ran = 0;
  try {
    const jobs = listJobs();
    for (const job of jobs) {
      if (!job.enabled || !job.query) continue;
      const due = !job.lastRunAt || now - new Date(job.lastRunAt).getTime() >= CADENCE_MS[job.cadence];
      if (!due) continue;
      try {
        await runDiscovery(job.query, 'scheduler', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly');
      } catch {
        // one retry with the same budgets; failures land in the run history
        try {
          await runDiscovery(job.query, 'scheduler (retry)', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly');
        } catch (e2) {
          audit({ provider: 'system', mode: 'mock', action: 'schedule-run', subject: job.id, outcome: 'error', detail: (e2 as Error).message });
        }
      }
      job.lastRunAt = new Date(now).toISOString();
      ran += 1;
    }
    store.raw.scheduledJobs = jobs;
    store.save();
  } finally {
    running = false;
  }
  return ran;
}

/** Start the loop — call ONLY from the server entrypoint, never from tests. */
export function startScheduler(): void {
  if (!schedulerEnabled() || timer) return;
  timer = setInterval(() => { void tickScheduler(); }, 60 * 60_000); // hourly due-check
  timer.unref?.();
}
