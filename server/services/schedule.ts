import { z } from 'zod';
import { schedulerEnabled } from '../env';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { getConfig, setConfig } from '../db/repos/operations';
import { scheduledJobSchema, type DiscoveryRun, type ScheduledJob } from '../../shared/discovery';
import { runDiscovery, importCandidates } from './discovery';
import { existingCandidates } from '../sourcing/dedupe';
import { runEnrichment } from './enrichment';

const JOBS_KEY = 'scheduled-jobs';

/**
 * Test-only override for the enrichment call `autoImportRun` makes.
 *
 * Real enrichment does real outbound HTTP against whatever domains the
 * newly-imported companies carry, and there is no per-test network mock
 * for this layer the way `installFixtureSources` provides one for
 * discovery. With no override installed, `autoImportRun` skips the
 * enrichment call entirely in the test environment (see below) — safe by
 * default. A test that wants to assert the wiring itself installs a spy
 * here instead of relying on that default.
 */
let enrichmentRunnerOverride: typeof runEnrichment | null = null;
export function __setEnrichmentRunnerForTests(runner: typeof runEnrichment | null): void {
  enrichmentRunnerOverride = runner;
}

/**
 * Auto-imports a run's own new candidates instead of leaving them for a
 * human to import from the candidate preview, and immediately researches
 * them — by explicit request, now every discovery run (scheduled or
 * manually triggered from the Discovery page) does both; contrast
 * server/services/discovery.ts's importCandidates, which every OTHER
 * caller (selective import, CSV, etc.) still treats as a distinct human
 * action. Import is scoped to exactly the candidates THIS run produced
 * (matched by runId), so a human's still-pending candidates from a
 * DIFFERENT run are never swept in. Duplicates are skipped rather than
 * merged or force-imported, matching the UI's own default policy.
 *
 * Skip reasons are audited rather than discarded: with no human import
 * click to notice a candidate went missing, a duplicate/unclassifiable/
 * validation skip here would otherwise be silently unrecoverable.
 *
 * Enrichment runs on exactly the companies THIS call newly created —
 * never `outcome.merged` (an exact match to an existing record, which a
 * human may already be mid-review on) — through the same pipeline the
 * "Research again" button uses (`apply: true`), so a reviewer opening
 * "Awaiting Review" finds a founder/website/vertical already researched
 * where public evidence exists, rather than the raw import placeholder.
 * A research failure is audited and never rolls back or blocks the
 * import: a company that fails research still lands in the queue, just
 * unenriched, exactly as it did before this existed.
 */
export async function autoImportRun(run: DiscoveryRun, actor: string): Promise<string[]> {
  const ids = existingCandidates()
    .filter((c) => c.runId === run.id && c.status === 'pending')
    .map((c) => c.id);
  if (ids.length === 0) return [];
  const outcome = importCandidates({ candidateIds: ids, actor, duplicateAction: 'skip' });
  for (const s of outcome.skipped) {
    audit({
      provider: 'system', mode: 'local', action: 'auto-import-skip', subject: s.id, outcome: 'blocked',
      detail: `${s.companyName ?? s.id} — ${s.code}: ${s.reason}`,
    });
  }
  const runner = enrichmentRunnerOverride ?? (process.env.NODE_ENV === 'test' ? null : runEnrichment);
  if (outcome.imported.length > 0 && runner) {
    try {
      await runner({ apply: true, companyIds: outcome.imported, initiatedBy: `${actor} (auto-enrich)` });
    } catch (e) {
      audit({
        provider: 'system', mode: 'local', action: 'auto-enrich-failed', subject: run.id, outcome: 'error',
        detail: `Research failed for ${outcome.imported.length} newly-imported company/companies: ${(e as Error).message}`,
      });
    }
  }
  return outcome.imported;
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
 * candidates are auto-imported AND auto-researched (see autoImportRun
 * above) rather than left for a human to import from the candidate
 * preview — by explicit request, since the firm wants the weekly cadence
 * fully unattended and reviewer-ready. Research reads only public pages
 * already on record (company site, filings, press, accelerator
 * profiles) — it is not "contacting founders" in the sense the hard rule
 * above refers to. They still land in Awaiting Review, same as any
 * import; nothing about disposition, HubSpot, or outreach becomes
 * automatic.
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
  await autoImportRun(run, actor);
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
        await autoImportRun(await runDiscovery(job.query, 'scheduler', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly'), 'scheduler');
      } catch {
        // one retry with the same budgets; failures land in the run history
        try {
          await autoImportRun(await runDiscovery(job.query, 'scheduler (retry)', job.cadence === 'weekly' ? 'scheduled-weekly' : 'scheduled-biweekly'), 'scheduler');
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
