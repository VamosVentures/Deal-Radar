import { failureLabel, type SourceFailureKind } from './errors';
import type { DiscoverySourceId } from '../../shared/discovery';
import type { RawCandidate } from './normalize';

/**
 * Source-run logging: the per-source outcome recorded on every
 * discovery run. `mode` is honest — 'live' only when a real external
 * call produced the data; failures carry a typed `failureKind` so the
 * UI and audit log can say exactly what went wrong. `durationMs` is
 * the real elapsed time of the adapter call (undefined for a skip,
 * since nothing was attempted) — used by source-quality analytics
 * instead of a fabricated response time.
 */
export interface SourceRunResult {
  sourceId: DiscoverySourceId;
  mode: 'live' | 'local' | 'simulated' | 'failed' | 'skipped';
  candidates: RawCandidate[];
  apiCalls: number;
  detail: string;
  failureKind?: SourceFailureKind;
  durationMs?: number;
}

export function liveResult(sourceId: DiscoverySourceId, candidates: RawCandidate[], apiCalls: number, detail: string, durationMs?: number): SourceRunResult {
  return { sourceId, mode: 'live', candidates, apiCalls, detail, ...(durationMs !== undefined ? { durationMs } : {}) };
}

export function failedResult(sourceId: DiscoverySourceId, failureKind: SourceFailureKind, apiCalls: number, detail: string, durationMs?: number): SourceRunResult {
  return {
    sourceId,
    mode: 'failed',
    candidates: [], // failures NEVER substitute sample records
    apiCalls,
    detail: `${failureLabel(failureKind)}: ${detail}`,
    failureKind,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function skippedResult(sourceId: DiscoverySourceId, detail: string, failureKind?: SourceFailureKind): SourceRunResult {
  return { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail, failureKind };
}
