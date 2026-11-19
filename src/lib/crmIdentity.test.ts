import { describe, expect, it } from 'vitest';
import { founderDemographics } from './crm';
import { verifiedDemographicSchema } from '../../shared/integrations';
import type { Founder } from '../types';

/**
 * Founder identity recorded from an uploaded file ("Import with Claude",
 * basis 'Recorded in uploaded file') must reach HubSpot labeled as such —
 * not dressed up as self-identified — and still pass the CRM guardrail.
 */
describe('founderDemographics for identity recorded from an uploaded file', () => {
  const founder: Founder = {
    name: 'Ana Ruiz', role: 'CEO', background: 'Ex-Stripe.',
    identity: { latinoLed: true, femaleLed: true, basis: 'Recorded in uploaded file', source: 'Row 3 of "deals.csv", uploaded by Andrew on 2026-11-18 (Latino-led? = Yes)' },
  };

  it('maps each indicator as "Recorded by Vamos", passing the guardrail schema', () => {
    const demo = founderDemographics(founder);
    expect(demo.map((d) => d.indicator)).toEqual(['Latino-led', 'Female-led']);
    for (const d of demo) {
      expect(d).toMatchObject({ basis: 'Recorded in uploaded file', verificationStatus: 'Recorded by Vamos' });
      expect(verifiedDemographicSchema.safeParse(d).success).toBe(true);
    }
  });

  it('leaves self-identified identity mapped as before', () => {
    const demo = founderDemographics({ ...founder, identity: { latinoLed: true, basis: 'Self-identified', source: 'Founder intake form 2026' } });
    expect(demo[0].verificationStatus).toBe('Self-reported');
  });
});
