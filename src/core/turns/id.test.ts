import { describe, expect, it } from 'vitest';
import {
  backfillLegacyTurnId,
  deriveDeterministicTurnId,
} from './id.js';

describe('turn IDs', () => {
  it('derives the pinned deterministic ID for a live turn seed', () => {
    expect(deriveDeterministicTurnId(
      'icp-reply:companion-1:channel-1:message-1',
    )).toBe('4c290b0d-5f76-7efb-adca-60e96208f8c0');
  });

  it('backfills the pinned deterministic ID for a legacy journal seed', () => {
    expect(backfillLegacyTurnId(
      'legacy-turn:channel-1:entry-1:2026-01-01T00:00:00.000Z:user',
    )).toBe('534ab088-e7df-77ab-aafb-613ea550c4cc');
  });
});
