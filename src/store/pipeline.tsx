import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PipelineItem, PipelineStage } from '../types';

const STORAGE_KEY = 'vamos-deal-radar:pipeline:v1';

const SEED: PipelineItem[] = [
  { companyId: 'c-solcare', stage: 'In conversation', owner: 'DR', lastTouch: '2026-07-09', nextStep: 'Send diligence checklist after Friday call', notes: 'Warm intro via Techstars mentor.' },
  { companyId: 'c-cuadrilla', stage: 'Deal review', owner: 'MG', lastTouch: '2026-07-11', nextStep: 'Partner memo due 7/17', notes: 'Strongest seed-stage fit this quarter.' },
  { companyId: 'c-remisa', stage: 'Outreach drafted', owner: 'DR', lastTouch: '2026-07-07', nextStep: 'Personalize draft with dLocal angle, human review before send', notes: '' },
  { companyId: 'c-voltaria', stage: 'In conversation', owner: 'AL', lastTouch: '2026-07-06', nextStep: 'Site visit to Santa Fe co-op', notes: 'Founder prefers email over calls.' },
  { companyId: 'c-stablemesa', stage: 'To research', owner: 'AL', lastTouch: '2026-07-01', nextStep: 'Resolve DeFi policy exception with partners first', notes: 'Do not contact until exception is reviewed.' },
  { companyId: 'c-lienzo', stage: 'Passed', owner: 'MG', lastTouch: '2026-06-20', nextStep: 'Revisit at Series A', notes: 'Passed on valuation; strong team, stay close.' },
];

interface PipelineApi {
  items: PipelineItem[];
  addToPipeline: (companyId: string) => void;
  moveStage: (companyId: string, stage: PipelineStage) => void;
  updateItem: (companyId: string, patch: Partial<PipelineItem>) => void;
  removeItem: (companyId: string) => void;
  reset: () => void;
}

const Ctx = createContext<PipelineApi | null>(null);

function load(): PipelineItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PipelineItem[];
  } catch {
    /* corrupted storage falls through to seed */
  }
  return SEED;
}

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<PipelineItem[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* storage unavailable — keep in-memory state */
    }
  }, [items]);

  const api = useMemo<PipelineApi>(
    () => ({
      items,
      addToPipeline: (companyId) =>
        setItems((prev) =>
          prev.some((i) => i.companyId === companyId)
            ? prev
            : [
                ...prev,
                {
                  companyId,
                  stage: 'To research',
                  owner: '—',
                  lastTouch: new Date().toISOString().slice(0, 10),
                  nextStep: 'Assign owner and research plan',
                  notes: '',
                },
              ],
        ),
      moveStage: (companyId, stage) =>
        setItems((prev) =>
          prev.map((i) =>
            i.companyId === companyId
              ? { ...i, stage, lastTouch: new Date().toISOString().slice(0, 10) }
              : i,
          ),
        ),
      updateItem: (companyId, patch) =>
        setItems((prev) => prev.map((i) => (i.companyId === companyId ? { ...i, ...patch } : i))),
      removeItem: (companyId) => setItems((prev) => prev.filter((i) => i.companyId !== companyId)),
      reset: () => setItems(SEED),
    }),
    [items],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePipeline(): PipelineApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePipeline must be used inside PipelineProvider');
  return ctx;
}
