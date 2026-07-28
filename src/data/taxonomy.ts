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
    id: 'robotics',
    name: 'Robotics',
    short: 'Robotics',
    core: true,
    description:
      'Physical automation and the software that controls it — promoted from an Other-Industries subcategory to a core sector.',
    subcategories: [
      { name: 'Industrial & warehouse automation' },
      { name: 'Field & agricultural robotics' },
      { name: 'Healthcare & surgical robotics' },
      { name: 'Robotics software & simulation' },
      { name: 'Perception & control systems' },
      {
        name: 'Humanoid & general-purpose robots',
        exception:
          'Typically hardware-heavy — flag for partner review under the hardware-heavy policy exception; never auto-reject.',
      },
    ],
  },
  {
    id: 'spacetech',
    name: 'Space Tech',
    short: 'Space',
    core: true,
    description:
      'Space infrastructure, data, and the ground software layer — promoted from an Other-Industries subcategory to a core sector.',
    subcategories: [
      { name: 'Earth observation & geospatial data' },
      { name: 'Satellite communications' },
      { name: 'Ground-segment & mission software' },
      { name: 'Space situational awareness' },
      {
        name: 'Launch & in-space hardware',
        exception:
          'Typically hardware-heavy and capital-intensive — flag for partner review under the hardware-heavy policy exception; never auto-reject.',
      },
    ],
  },
  {
    id: 'ai',
    name: 'General AI',
    short: 'AI',
    core: true,
    description:
      'Foundational AI capability and tooling that is not specific to another sector — promoted from an Other-Industries subcategory to a core sector.',
    subcategories: [
      { name: 'Foundation models & training infrastructure' },
      { name: 'Inference & serving infrastructure' },
      { name: 'AI developer tooling' },
      { name: 'Evaluation, safety & observability' },
      { name: 'Data infrastructure for AI' },
      { name: 'Vertical-agnostic AI applications' },
    ],
  },
  {
    id: 'aoi',
    name: 'Other Industries',
    short: 'Other',
    core: false,
    description:
      'Genuine catch-all for companies outside the six core sectors, scored on a separate scale. Robotics, Space Tech, and General AI were promoted out of this category into core sectors of their own; what remains is off-thesis or unclassified. Hardware-heavy or off-thesis companies carry a visible Policy Exception.',
    subcategories: [
      { name: 'Unclassified / needs human categorization' },
      {
        name: 'Off-thesis category',
        exception:
          'Outside the firm’s stated sectors — flag for partner review; never auto-reject.',
      },
    ],
  },
];

export const verticalById = (id: VerticalId): Vertical =>
  VERTICALS.find((v) => v.id === id)!;

/**
 * Single source of truth for "what sectors exist", in canonical display
 * order. Before this existed, the same list was hand-copied into the
 * Discovery page, the Schedule editor, the Connectors panel, and the
 * Stealth Radar filter — five copies that had to be kept in sync by
 * hand. Derive from these instead of writing another literal list.
 */
export const VERTICAL_IDS: VerticalId[] = VERTICALS.map((v) => v.id);

/** The core investment sectors — everything except the `aoi` catch-all. */
export const CORE_VERTICAL_IDS: VerticalId[] = VERTICALS.filter((v) => v.core).map((v) => v.id);

/** `{ id, name }` pairs for rendering a <select>, in canonical order. */
export const VERTICAL_OPTIONS: { id: VerticalId; name: string }[] =
  VERTICALS.map((v) => ({ id: v.id, name: v.name }));

export const PREFERRED_STATES = ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'];
