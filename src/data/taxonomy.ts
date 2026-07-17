import type { VerticalId } from '../types';

export interface Vertical {
  id: VerticalId;
  name: string;
  short: string;
  core: boolean;
  description: string;
  subcategories: { name: string; exception?: string }[];
}

export const VERTICALS: Vertical[] = [
  {
    id: 'health',
    name: 'Health & Wellness',
    short: 'Health',
    core: true,
    description:
      'Technology-enabled care, prevention, and the infrastructure behind it.',
    subcategories: [
      { name: 'Personalized care (AI / tech-enabled)' },
      { name: 'Cancer' },
      { name: 'Brain health' },
      { name: 'Longevity' },
      { name: 'Genomics & personalized medicine' },
      { name: "Women's health" },
      { name: 'Healthcare infrastructure' },
      { name: 'Healthcare finance' },
      { name: 'Healthcare workforce technology' },
    ],
  },
  {
    id: 'fintech',
    name: 'FinTech',
    short: 'FinTech',
    core: true,
    description:
      'Financial infrastructure, access, and wealth-building for the next generation of customers.',
    subcategories: [
      { name: 'New financial infrastructure' },
      { name: 'Payments' },
      { name: 'Wealth & capital markets' },
      { name: 'Investing' },
      { name: 'Wealth planning' },
      { name: 'Access to capital' },
      {
        name: 'DeFi & blockchain',
        exception:
          'Adjacent / exception category — may conflict with current firm exclusions. Flag for partner review; do not auto-reject.',
      },
    ],
  },
  {
    id: 'fow',
    name: 'Future of Work',
    short: 'Work',
    core: true,
    description:
      'How people and AI systems work together, and the tools that make work better.',
    subcategories: [
      { name: 'Human-AI collaboration' },
      { name: 'AI-native work platforms' },
      { name: 'AI copilots' },
      { name: 'Autonomous agents' },
      { name: 'Human-centered automation' },
      { name: 'Next-generation work infrastructure' },
      { name: 'Workflow & collaboration tools' },
      { name: 'Frontline & essential-worker technology' },
      { name: 'Creator & microbusiness enablement' },
    ],
  },
  {
    id: 'sustainability',
    name: 'Sustainability',
    short: 'Sustain',
    core: true,
    description:
      'Energy transition software and digital infrastructure for a decarbonizing grid.',
    subcategories: [
      { name: 'Renewable energy' },
      { name: 'Nuclear energy' },
      { name: 'Hydrogen' },
      { name: 'Geothermal' },
      { name: 'Digital energy infrastructure' },
      { name: 'Energy & operations optimization' },
      { name: 'Smart grids' },
      { name: 'Renewable-energy digital infrastructure' },
    ],
  },
  {
    id: 'aoi',
    name: 'Areas of Interest',
    short: 'Adjacent',
    core: false,
    description:
      'Adjacent-interest areas scored separately from the four core sectors. Hardware-heavy or off-thesis companies carry a visible Policy Exception.',
    subcategories: [
      { name: 'Robotics', exception: 'Often hardware-heavy — check thesis fit.' },
      { name: 'Space technology', exception: 'Often hardware-heavy — check thesis fit.' },
      { name: 'General AI' },
    ],
  },
];

export const verticalById = (id: VerticalId): Vertical =>
  VERTICALS.find((v) => v.id === id)!;

export const PREFERRED_STATES = ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'];
