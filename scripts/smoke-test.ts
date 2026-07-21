#!/usr/bin/env -S npx tsx
/**
 * npm run smoke-test — a deployment smoke test, not a substitute for
 * the real test suite. Builds the frontend if needed, starts the
 * production server against an isolated temp database (never the
 * developer's real one), confirms liveness/readiness, confirms the
 * frontend loads, confirms an admin-only route is gated even
 * unauthenticated, then stops the server cleanly.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8799; // distinct from the normal dev port, to avoid colliding with a real running instance
const projectRoot = path.resolve(import.meta.dirname, '..');

function log(msg: string): void {
  console.log(`[smoke-test] ${msg}`);
}

async function waitFor(url: string, timeoutMs: number): Promise<Response> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Timed out waiting for ${url}`);
}

async function main() {
  if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
    log('No production build found — running `npm run build` first...');
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  }

  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-smoke-')), 'smoke.db');
  log(`Starting production server on :${PORT} against an isolated database (${tmpDb})...`);

  const child = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_FILE: tmpDb,
      DATA_FILE: tmpDb.replace('.db', '-kv.db'),
      // No ADMIN_PASSWORD on purpose — proves the admin gate fails
      // closed rather than open when unconfigured.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout?.on('data', (d) => { serverOutput += String(d); });
  child.stderr?.on('data', (d) => { serverOutput += String(d); });

  const stop = () => new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref();
  });

  try {
    const live = await waitFor(`http://localhost:${PORT}/health/live`, 15_000);
    if (!live.ok) throw new Error(`/health/live returned ${live.status}`);
    log('/health/live: OK');

    const ready = await fetch(`http://localhost:${PORT}/health/ready`);
    const readyBody = await ready.json() as { status: string; checks?: Record<string, { ok: boolean }> };
    if (ready.status !== 200 && ready.status !== 503) throw new Error(`/health/ready returned unexpected status ${ready.status}`);
    log(`/health/ready: ${readyBody.status} (database: ${readyBody.checks?.database?.ok}, migrations: ${readyBody.checks?.migrations?.ok})`);
    if (!readyBody.checks?.database?.ok || !readyBody.checks?.migrations?.ok) {
      throw new Error('Database or migrations check failed in /health/ready.');
    }

    const frontend = await fetch(`http://localhost:${PORT}/`);
    const html = await frontend.text();
    if (!frontend.ok || !html.includes('Deal Radar')) throw new Error('Frontend did not load the expected content at /.');
    log('Frontend loads at /: OK');

    const gated = await fetch(`http://localhost:${PORT}/api/admin/status`);
    if (gated.status !== 401) throw new Error(`Expected 401 from an unauthenticated admin route, got ${gated.status}.`);
    log('Unauthenticated admin route is gated (401): OK');

    log('All smoke-test checks passed.');
  } catch (e) {
    console.error(`[smoke-test] FAILED: ${(e as Error).message}`);
    console.error('--- server output ---');
    console.error(serverOutput);
    await stop();
    process.exit(1);
  }

  await stop();
  log('Server stopped cleanly.');
}

main().catch((e) => {
  console.error(`[smoke-test] Unexpected error: ${(e as Error).message}`);
  process.exit(1);
});
