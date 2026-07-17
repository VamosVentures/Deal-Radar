import { z } from 'zod';
import { COMPANIES } from './companies';
import { ENRICHMENT } from './enrichment';
import { STEALTH_FOUNDERS } from './stealth';
import type { Company, StealthFounder } from '../types';

/**
 * Runtime validation of the data layer. Two rules are enforced here so
 * bad data fails loudly instead of quietly shaping recommendations:
 *
 *  1. Any demographic indicator MUST carry a self-identification basis
 *     and a named source. Records without them are rejected.
 *  2. Every company must carry at least one piece of sourced evidence.
 *
 * When live sources (Supabase / API) are configured, route their rows
 * through these same schemas before they reach the UI.
 */

const identitySchema = z.object({
  latinoLed: z.boolean().optional(),
  femaleLed: z.boolean().optional(),
  otherUnderrepresented: z.string().optional(),
  basis: z.enum(['Self-identified', 'Verified public statement']),
  source: z.string().min(8, 'Identity indicators require a named verification source'),
});

const evidenceSchema = z.object({
  claim: z.string().min(3),
  source: z.string().min(3),
  url: z.string().url(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(['Filing', 'News', 'Founder statement', 'Product', 'Accelerator', 'Hiring signal', 'Database record']),
});

const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  oneLiner: z.string(),
  vertical: z.enum(['health', 'fintech', 'fow', 'sustainability', 'aoi']),
  subcategory: z.string(),
  stage: z.enum(['Pre-seed', 'Seed', 'Series A', 'Stealth']),
  city: z.string(),
  state: z.string().length(2),
  foundedYear: z.number().int(),
  teamSize: z.number().int().positive(),
  raising: z.string().optional(),
  traction: z.object({ level: z.number().min(0).max(10), note: z.string().min(3) }),
  founders: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      background: z.string(),
      identity: identitySchema.optional(),
      email: z.string().email().optional(),
      emailSource: z.string().min(6, 'Founder emails require a verification source').optional(),
      linkedin: z.string().url().optional(),
    }).refine((f) => !f.email || !!f.emailSource, {
      message: 'A founder email may only be stored with an emailSource explaining how it was verified',
    }),
  ).min(1),
  evidence: z.array(evidenceSchema).min(1, 'Every company needs sourced evidence'),
  flags: z.array(z.enum(['defi-adjacent', 'hardware-heavy', 'outside-thesis'])),
  website: z.string().url().optional(),
  accelerator: z.string().optional(),
  dateFirstSurfaced: z.string().optional(),
  lastRefreshed: z.string().optional(),
});

/** Merge optional enrichment (websites, verified emails) before validation. */
function enrich(raw: typeof COMPANIES): typeof COMPANIES {
  return raw.map((c) => {
    const e = ENRICHMENT[c.id];
    if (!e) return c;
    return {
      ...c,
      website: e.website ?? c.website,
      accelerator: e.accelerator ?? c.accelerator,
      dateFirstSurfaced: e.dateFirstSurfaced ?? c.dateFirstSurfaced,
      founders: c.founders.map((f) => ({ ...f, ...(e.founders?.[f.name] ?? {}) })),
    };
  });
}

const stealthSchema = z.object({
  id: z.string(),
  name: z.string(),
  lastKnownRole: z.string(),
  likelyVertical: z.enum(['health', 'fintech', 'fow', 'sustainability', 'aoi']),
  likelyFocus: z.string(),
  city: z.string(),
  state: z.string().length(2),
  confidence: z.enum(['Low', 'Medium', 'High']),
  signals: z.array(
    z.object({ signal: z.string(), source: z.string(), url: z.string().url(), date: z.string() }),
  ).min(1),
  identity: identitySchema.optional(),
});

export function loadCompanies(): Company[] {
  return z.array(companySchema).parse(enrich(COMPANIES)) as Company[];
}

export function loadStealthFounders(): StealthFounder[] {
  return z.array(stealthSchema).parse(STEALTH_FOUNDERS) as StealthFounder[];
}
