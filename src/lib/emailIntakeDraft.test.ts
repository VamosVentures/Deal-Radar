import { describe, expect, it } from 'vitest';
import { draftFor, patchFrom } from './emailIntakeDraft';
import type { EmailIntakeCandidate } from './api';

/**
 * The review card edits only the first founder. Saving used to send just
 * that one, which replaced the whole list — approving the 2026-10-28 YC
 * email kept 1 of Epsilab's 4 founders (and 1 of 2–3 for the others).
 */

const EPSILAB = {
  name: 'Epsilab', vertical: 'fow',
  founders: [
    { name: 'Evan Hu', role: 'Co-founder', background: 'Previously co-founder and CTO at Shortbread (YC W23).' },
    { name: 'Matthew Olsen', role: 'Founder', background: 'Building RL environments.' },
    { name: 'Fengjiao Peng', role: 'Cofounder', background: 'ML Researcher at MIT Media Lab.' },
    { name: 'Joanne Wang', role: 'Cofounder', background: '2nd time YC founder.' },
  ],
  evidence: [{ type: 'Inbound referral', claim: 'Long horizon RL environments', source: 'Forwarded email', url: '', date: '2026-10-28' }],
};

const candidate = (extracted: Record<string, unknown>) => ({ id: 1, extracted } as unknown as EmailIntakeCandidate);

describe('email-intake review card draft → PATCH', () => {
  it('keeps the first founder\'s email and LinkedIn on save, and sends a reviewer\'s edit', () => {
    const withContact = {
      ...EPSILAB,
      founders: [{ ...EPSILAB.founders[0], email: 'evan@epsilab.ai', linkedin: 'https://www.linkedin.com/in/evanhu' }, ...EPSILAB.founders.slice(1)],
    };
    const draft = draftFor(candidate(withContact));
    expect(draft).toMatchObject({ founderEmail: 'evan@epsilab.ai', founderLinkedin: 'https://www.linkedin.com/in/evanhu' });
    const untouched = (patchFrom(draft, withContact).founders as Record<string, string>[])[0];
    expect(untouched).toMatchObject({ email: 'evan@epsilab.ai', linkedin: 'https://www.linkedin.com/in/evanhu' });
    const edited = (patchFrom({ ...draft, founderEmail: 'evan.hu@epsilab.ai', founderLinkedin: '' }, withContact).founders as Record<string, string>[])[0];
    expect(edited.email).toBe('evan.hu@epsilab.ai');
    // A cleared box sends nothing — the PATCH schema rejects an empty string.
    expect(edited).not.toHaveProperty('linkedin');
  });

  it('keeps every founder when saving an untouched card', () => {
    const patch = patchFrom(draftFor(candidate(EPSILAB)), EPSILAB);
    expect((patch.founders as { name: string }[]).map((f) => f.name))
      .toEqual(['Evan Hu', 'Matthew Olsen', 'Fengjiao Peng', 'Joanne Wang']);
  });

  it('applies an edit to the first founder and keeps the rest unchanged', () => {
    const draft = { ...draftFor(candidate(EPSILAB)), founderRole: 'CEO' };
    const founders = patchFrom(draft, EPSILAB).founders as Record<string, string>[];
    expect(founders[0]).toMatchObject({ name: 'Evan Hu', role: 'CEO' });
    expect(founders.slice(1)).toEqual(EPSILAB.founders.slice(1));
  });

  it('gives a co-founder with no background the same defaults as the first founder', () => {
    const nuum = {
      name: 'Nuum Robotics', vertical: 'frontier',
      founders: [{ name: 'Isaac MacLean', role: 'Co-Founder' }, { name: 'Mark Seemann' }],
    };
    expect(patchFrom(draftFor(candidate(nuum)), nuum).founders).toEqual([
      { name: 'Isaac MacLean', role: 'Co-Founder', background: 'Not on record.' },
      { name: 'Mark Seemann', role: 'Founder', background: 'Not on record.' },
    ]);
  });

  it('sends no founders when none were found or entered', () => {
    const none = { name: 'Quiet Co', vertical: 'fow' };
    expect(patchFrom(draftFor(candidate(none)), none).founders).toBeUndefined();
  });
});
