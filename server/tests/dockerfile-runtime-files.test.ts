import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The production image (Dockerfile, runtime stage) copies server/,
 * shared/ and scripts/ whole, but only a hand-picked list of files from
 * src/. A server-side import of any other src/ file passes every local
 * check — typecheck, tests, the Vite build — and then the container
 * fails to boot with ERR_MODULE_NOT_FOUND. That is exactly how the
 * 2026-10-27 email-intake deploy failed on Render (emailIntake.ts →
 * src/lib/emailIntakePrompt.ts was not copied).
 *
 * This test walks the runtime import graph from server/ and shared/
 * (tests excluded) into src/, and fails if any reachable src/ file is
 * not covered by a Dockerfile COPY line.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function copiedSrcPaths(): string[] {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  return [...runtime.matchAll(/^COPY\s+(src\/\S+)\s+/gm)].map((m) => m[1].replace(/\/$/, ''));
}

function isCopied(rel: string, copied: string[]): boolean {
  return copied.some((c) => rel === c || rel.startsWith(`${c}/`));
}

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'tests' ? [] : listTs(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every src/ file reachable at runtime from server/ and shared/. */
function reachableSrcFiles(): string[] {
  const queue = [...listTs(path.join(root, 'server')), ...listTs(path.join(root, 'shared'))];
  const seen = new Set<string>(queue);
  const srcFiles = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = fs.readFileSync(file, 'utf8');
    // Value imports and re-exports only — `import type` is erased at runtime.
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const target = resolveImport(file, m[1]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const rel = path.relative(root, target).split(path.sep).join('/');
      if (rel.startsWith('src/')) srcFiles.add(rel);
      queue.push(target);
    }
  }
  return [...srcFiles].sort();
}

describe('Dockerfile runtime image', () => {
  it('copies every src/ file the server imports at runtime', () => {
    const copied = copiedSrcPaths();
    const reachable = reachableSrcFiles();
    expect(reachable.length).toBeGreaterThan(0); // the scan itself must be finding imports
    const missing = reachable.filter((f) => !isCopied(f, copied));
    expect(missing, `Add a COPY line to the Dockerfile runtime stage for: ${missing.join(', ')}`).toEqual([]);
  });
});
