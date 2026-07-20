/**
 * Compatibility façade: the sourcing implementation lives in
 * server/sourcing/ (types, validation, normalization, dedupe,
 * enrichment, run logging, error handling, and one adapter per
 * source). Existing imports keep working through this module.
 */
export {
  ADAPTERS,
  getSourceMeta,
  runSource,
  __setSourceRunnerForTests,
  type SourceMeta,
  type SourceState,
} from '../sourcing';
export type { SourceRunResult } from '../sourcing/runlog';
export type { RawCandidate } from '../sourcing/normalize';
export type { LeadEvidence, SourceAdapter, AdapterOutcome } from '../sourcing/types';
