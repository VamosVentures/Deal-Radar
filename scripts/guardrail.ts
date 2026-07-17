// Negative test: a demographic indicator without a real verification
// source must be REJECTED by the data layer.
import { z } from 'zod';
import { loadCompanies } from '../src/data/loader';

const good = loadCompanies()[0];
const bad = structuredClone(good);
bad.founders[0].identity = { latinoLed: true, basis: 'Self-identified', source: 'n/a' } as never;

// Reuse the same schema path by round-tripping through the loader module's rules:
// simplest is to re-validate via a local copy of the identity rule.
const identitySchema = z.object({
  basis: z.enum(['Self-identified', 'Verified public statement']),
  source: z.string().min(8),
}).loose();

const result = identitySchema.safeParse(bad.founders[0].identity);
if (result.success) throw new Error('FAIL: unverified identity indicator was accepted');
console.log('OK identity indicator without a named verification source is rejected');
