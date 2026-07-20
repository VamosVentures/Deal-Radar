import { z } from 'zod';
import { leadEvidenceSchema, type AdapterFailure, type LeadEvidence } from './types';

/**
 * Response validation. External payloads are never trusted: each
 * adapter parses the body it received against an explicit Zod schema
 * and fails with `invalid-response` on any mismatch — no partial
 * guessing, no silent coercion into fake leads.
 */

export type Validated<T> = { ok: true; data: T } | { ok: false; failure: AdapterFailure };

export function validateExternal<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  sourceLabel: string,
  apiCalls: number,
): Validated<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    failure: {
      ok: false,
      failure: 'invalid-response',
      apiCalls,
      detail: `${sourceLabel} returned a response that did not match the expected schema (${first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'unknown issue'}). No data was collected.`,
    },
  };
}

/** Parse a JSON body defensively; malformed JSON is an invalid response, not a crash. */
export async function readJson(res: Response): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Validate every lead an adapter built. Invalid leads are dropped and
 * counted — a partially-usable source still returns its valid leads,
 * but nothing invalid ever enters the pipeline.
 */
export function validateLeads(leads: unknown[]): { valid: LeadEvidence[]; rejected: number } {
  const valid: LeadEvidence[] = [];
  let rejected = 0;
  for (const lead of leads) {
    const parsed = leadEvidenceSchema.safeParse(lead);
    if (parsed.success) valid.push(parsed.data);
    else rejected += 1;
  }
  return { valid, rejected };
}
