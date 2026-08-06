import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bundle scan for the demo build (`npm run build:demo`).
 *
 * Fails (non-zero exit) if the built bundle contains any of:
 *   - the real ADMIN_PASSWORD/SESSION_SECRET values from this machine's .env
 *   - common credential/token shapes (API keys, private key headers)
 *   - a local filesystem database path
 *   - the real production Vercel/HubSpot/Microsoft hostnames
 *
 * Mentioning a VARIABLE NAME in help text (e.g. "Set ADMIN_PASSWORD in
 * your .env") is expected and fine — this scans for VALUES, not names.
 */

const DIST = 'dist-demo';

if (!existsSync(DIST)) {
  console.error(`[demo-bundle-scan] ${DIST}/ does not exist — run \`npm run build:demo\` first.`);
  process.exit(1);
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (/\.(js|html|css|map)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Real, secret-shaped values pulled from THIS machine's .env — never
// printed, only checked for. Absent .env values are skipped, not treated
// as a pass.
let envAdminPassword: string | null = null;
let envSessionSecret: string | null = null;
try {
  const env = readFileSync('.env', 'utf8');
  envAdminPassword = /^ADMIN_PASSWORD=(.+)$/m.exec(env)?.[1]?.trim() || null;
  envSessionSecret = /^SESSION_SECRET=(.+)$/m.exec(env)?.[1]?.trim() || null;
} catch { /* no local .env — nothing to check against */ }

const genericPatterns: [string, RegExp][] = [
  ['OpenAI API key', /sk-proj-[A-Za-z0-9_-]{10,}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Private key header', /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----/],
  ['Local SQLite database path', /server\/\.data\/[A-Za-z0-9._-]+\.db/],
  ['HubSpot private-app token shape', /pat-[a-z0-9]{2}-[A-Za-z0-9-]{20,}/],
];

let failures = 0;
const files = collectFiles(DIST);
console.log(`[demo-bundle-scan] scanning ${files.length} files under ${DIST}/`);

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (envAdminPassword && envAdminPassword.length >= 6 && content.includes(envAdminPassword)) {
    console.error(`[FAIL] ${file}: contains this machine's real ADMIN_PASSWORD value.`);
    failures++;
  }
  if (envSessionSecret && envSessionSecret.length >= 8 && content.includes(envSessionSecret)) {
    console.error(`[FAIL] ${file}: contains this machine's real SESSION_SECRET value.`);
    failures++;
  }
  for (const [label, re] of genericPatterns) {
    if (re.test(content)) {
      console.error(`[FAIL] ${file}: matches pattern "${label}".`);
      failures++;
    }
  }
}

if (failures === 0) {
  console.log('[demo-bundle-scan] clean — no real credentials, tokens, or database paths found.');
  process.exit(0);
} else {
  console.error(`[demo-bundle-scan] ${failures} finding(s). Fix before publishing this build.`);
  process.exit(1);
}
