/**
 * Moved to shared/qualitySignals.ts — the All Deals table needs the same
 * signals the server uses, and duplicating them would let the two drift.
 * Re-exported here so existing server imports keep working.
 */
export * from '../../shared/qualitySignals';
