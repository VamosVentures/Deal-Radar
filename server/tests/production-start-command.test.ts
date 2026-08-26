import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production start command must run on production dependencies.
 *
 * This file exists because of an outage the entire rest of the suite was
 * structurally unable to catch. The Dockerfile's runtime stage installs
 * with `npm ci --omit=dev` (line 24), but `npm start` invoked `cross-env`,
 * which was a devDependency. The container therefore built green — the
 * build stage runs `npm ci` with everything — passed every one of the
 * 1211 tests inside that stage, and then failed at CMD with a missing
 * binary. Render served 502 on every route, including the health check.
 *
 * No test could see it, because tests run where devDependencies exist.
 * The only place the bug was observable was a container start, so what
 * is asserted here is the package manifest itself: every executable the
 * production start command invokes has to resolve from `dependencies`.
 *
 * `tsx` is in `dependencies` for the same reason and is not an oversight
 * — this image runs TypeScript directly (CMD ["npm", "start"]), and the
 * db:* operational scripts the Dockerfile copies in do too.
 */

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const dockerfile = fs.readFileSync(path.resolve(import.meta.dirname, '../../Dockerfile'), 'utf8');

/**
 * The first token of a command is the binary npm resolves from
 * node_modules/.bin. Anything of the form `KEY=value` in front of it is
 * a shell-level assignment, which is what `cross-env` was standing in
 * for and what a Linux container does natively.
 */
function invokedBinary(script: string): string {
  const first = script.trim().split(/\s+/).find((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
  return first ?? '';
}

describe('the production start command', () => {
  it('invokes only binaries that survive `npm ci --omit=dev`', () => {
    const binary = invokedBinary(pkg.scripts.start);
    expect(binary).toBeTruthy();
    expect(
      pkg.dependencies,
      `\`npm start\` runs "${binary}", which must be in dependencies — the runtime `
      + 'image installs with --omit=dev, so a devDependency here is a container that '
      + 'builds green and then cannot boot.',
    ).toHaveProperty(binary);
    expect(pkg.devDependencies).not.toHaveProperty(binary);
  });

  it('does not depend on cross-env, which the runtime image does not install', () => {
    // Docker sets NODE_ENV itself (Dockerfile line 21), so nothing needs
    // a cross-platform assignment shim at container start.
    expect(pkg.scripts.start).not.toContain('cross-env');
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
    // cross-env stays a devDependency — the dev-only scripts still use it.
    expect(pkg.devDependencies).toHaveProperty('cross-env');
  });

  it('still loads .env when one is present', () => {
    // Removing cross-env must not quietly drop env-file loading with it:
    // a deployment mounting a .env would then boot with no credentials
    // and report every integration as honestly disconnected.
    expect(pkg.scripts.start).toContain('--env-file-if-exists=.env');
  });

  it('keeps every operational script the image copies in runnable too', () => {
    // The Dockerfile COPYs scripts/ so backup, restore, and integrity
    // checks can be run against the live database. They are tsx scripts,
    // so the same rule applies to them.
    expect(dockerfile).toMatch(/^COPY scripts \.\/scripts$/m);
    for (const [name, script] of Object.entries(pkg.scripts)) {
      if (!name.startsWith('db:')) continue;
      const binary = invokedBinary(script);
      expect(pkg.dependencies, `\`npm run ${name}\` runs "${binary}"`).toHaveProperty(binary);
    }
  });
});
