import type { NextFunction, Request, Response } from 'express';
import { store } from './store';
import type { IntegrationAuditLog } from '../../shared/integrations';

// Secret-SHAPED substrings that should never end up in a log, even if
// a future call site accidentally interpolates one into a free-form
// string. Every audit() call passes through this before it is stored.
const SECRET_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._-]{10,}/gi,           // Authorization: Bearer <token>
  /\bsk-[a-z0-9]{10,}/gi,                  // OpenAI/Anthropic-style API keys
  /\b[a-f0-9]{32,}\b/gi,                   // long hex tokens/hashes
  /\b[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\b/gi, // JWT-shaped
];

/** Replace anything secret-shaped in free-form text with a placeholder. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function audit(
  entry: Omit<IntegrationAuditLog, 'id' | 'at'>,
): IntegrationAuditLog {
  const full: IntegrationAuditLog = {
    ...entry,
    subject: redactSecrets(entry.subject),
    detail: redactSecrets(entry.detail),
    id: store.nextId('audit'),
    at: new Date().toISOString(),
  };
  store.raw.audit.unshift(full);
  store.raw.audit = store.raw.audit.slice(0, 500);
  store.save();
  return full;
}

/** Request logging without secrets: method, path, status, ms. Never bodies. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
      );
    }
  });
  next();
}

// ── Duplicate-submission protection ──────────────────────────────
// Mutating routes accept an Idempotency-Key header. A key seen in
// the last two minutes is rejected so a double-clicked button can
// never create two CRM records or two drafts.

const seen = new Map<string, number>();
const WINDOW_MS = 2 * 60 * 1000;

export function idempotencyGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST') return next();
  const key = req.header('Idempotency-Key');
  if (!key) return next();
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > WINDOW_MS) seen.delete(k);
  if (seen.has(key)) {
    audit({
      provider: 'system',
      mode: 'local',
      action: `duplicate-submission ${req.path}`,
      subject: key.slice(0, 12),
      outcome: 'blocked',
      detail: 'Repeated Idempotency-Key within 2 minutes',
    });
    return res.status(409).json({
      error: 'duplicate_submission',
      message: 'This action was already submitted. The first submission is being used.',
    });
  }
  seen.set(key, now);
  next();
}

export function resetIdempotencyForTests() {
  seen.clear();
}
