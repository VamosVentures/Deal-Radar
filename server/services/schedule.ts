import { z } from 'zod';
import { schedulerEnabled } from '../env';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { getConfig, setConfig } from '../db/repos/operations';
import { scheduledJobSchema, type DiscoveryRun, type ScheduledJob } from '../../shared/discovery';
import { runDiscovery, importCandidates } from './discovery';
import { existingCandidates } from '../sourcing/dedupe';

const JOBS_KEY = 'scheduled-jobs';

/**
 * Scheduled runs auto-import their own new candidates — by explicit
 * request, this is the one path in the app where import is NOT a
 * separate human action (contrast server/services/discovery.ts's
 * importCandidates, which every other caller treats as such). Scoped
 * to exactly the candidates THIS run produced (matched by runId), so a
 * human's still-pending candidates from an earlier manual run are never
 * swept in. Duplicates are skipped rather than merged or force-imported,
 * matching the UI's own default policy.
 */
function autoImportRun(run: DiscoveryRun): void {
  const ids = existingCandidates()
    .filter((c) => c.runId === run.id && c.status === 'pending')
    .map((c) => c.id);
  if (ids.length === 0) return;
  importCandidates({ candidateIds: ids, actor: 'scheduler', duplicateAction: 'skip' });
}

function saveJobs(jobs: ScheduledJob[]): void {
  setConfig(JOBS_KEY, jobs);
}

/**
 * Scheduled sourcing. Schedules are ALWAYS storable as configuration;
 * they EXECUTE only when RUN_SCHEDULER=true on a continuously hosted
 * backend. When inactive, the UI shows "Configured but inactive" and
 * nothing pretends jobs will run. Scheduled runs reuse the discovery
 * pipeline — same budgets, same guardrails, and the same hard rule:
 * they never contact founders, send email, approve/reject deals, or
 * change HubSpot stages. UNLIKE a manual run, a scheduled run's new
 * candidates are auto-imported (see autoImportRun above) rather than
 * left for a human to import from the candidate preview — by explicit
 * request, since the firm wants the weekly cadence fully unattended.
 * They still land in Awaiting Review, same as any import; nothing
 * about disposition, HubSpot, or outreach becomes automatic.
 */

export function listJobs(): ScheduledJob[] {
  return getConfig(JOBS_KEY, z.array(scheduledJobSchema), []);
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
  saveJobs([...jobs, job]);
  audit({
    provider: 'system', mode: 'local', action: 'schedule-save', subject: job.id, outcome: 'ok',
    detail: `${job.cadence} ${job.jobType} — ${schedulerEnabled() ? 'scheduler active' : 'Configured but inactive (RUN_SCHEDULER=false)'}`,
  });
  return job;
}

export function deleteJob(id: string): void {
  saveJobs(listJobs().filter((j) => j.id !== id));
}

/**
 * Administrator-only "Run sourcing now": executes a saved schedule's
 * search immediately instead of waiting for its cadence. Goes through
 * the same `runDiscovery` overlap lock as every other run path, so it
 * cannot collide with a scheduler tick or a manual run in progress.
 */
export async function runJobNow(jobId: string, actor: string): Promise<DiscoveryRun> {
  const jobs = listJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw Object.assign(new Error('Scheduled job not found.'), { status: 404 });
  if (!job.query) throw Object.assign(new Error('This job has no saved search configuration to run.'), { status: 422 });
  const run = await runDiscovery(job.query, actor, job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly');
  autoImportRun(run);
  saveJobs(jobs.map((j) => (j.id === jobId ? { ...j, lastRunAt: new Date().toISOString() } : j)));
  audit({
    provider: 'system', mode: 'local', action: 'schedule-run-now', subject: jobId, outcome: 'ok',
    detail: `Manually triggered by ${actor} outside the normal cadence — run status ${run.status}`,
  });
  return run;
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
        autoImportRun(await runDiscovery(job.query, 'scheduler', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly'));
      } catch {
        // one retry with the same budgets; failures land in the run history
        try {
          autoImportRun(await runDiscovery(job.query, 'scheduler (retry)', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly'));
        } catch (e2) {
          audit({ provider: 'system', mode: 'local', action: 'schedule-run', subject: job.id, outcome: 'error', detail: (e2 as Error).message });
        }
      }
      job.lastRunAt = new Date(now).toISOString();
      ran += 1;
    }
    saveJobs(jobs);
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

/** Stop the loop — used by graceful shutdown so no new tick starts mid-shutdown. */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Whether the hourly tick timer is currently running (for /health/ready). */
export function schedulerRunning(): boolean {
  return timer !== null;
}
