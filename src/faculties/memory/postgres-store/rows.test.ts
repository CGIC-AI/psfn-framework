import { describe, it, expect } from 'vitest';
import { toMemoryRow, fromMemoryRow } from './rows.js';
import type { PurrMemory } from '../types.js';
import { evaluateMemoryPolicy } from '../../../system/trust/policy.js';

function baseMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    text: 'a memory',
    type: 'emotional',
    importance: 0.5,
    confidence: 0.8,
    emotionalValence: -0.4,
    salience: 0.5,
    sourceRef: 'tool:memory_write',
    extractedAt: 1000,
    lastAccessed: 1000,
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

describe('memory row emotional_texture round-trip (031.11.1)', () => {
  it('persists and restores the multi-signal emotional texture', () => {
    const memory = baseMemory({
      formationVAD: { valence: -0.4, arousal: 0.3, dominance: 0.1 },
      emotionalTexture: { discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 },
    });
    const row = toMemoryRow(memory);
    expect(row.emotional_texture).toEqual({ discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 });
    const restored = fromMemoryRow(row);
    expect(restored.emotionalTexture).toEqual({ discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 });
    // The VAD vector still round-trips independently.
    expect(restored.formationVAD).toEqual({ valence: -0.4, arousal: 0.3, dominance: 0.1 });
  });

  it('encodes a null texture column and restores it as undefined when absent', () => {
    const row = toMemoryRow(baseMemory());
    expect(row.emotional_texture).toBeNull();
    expect(fromMemoryRow(row).emotionalTexture).toBeUndefined();
  });

  it('restores undefined from a legacy row missing the column entirely', () => {
    const row = { ...toMemoryRow(baseMemory()) } as Record<string, unknown>;
    delete row.emotional_texture;
    expect(fromMemoryRow(row as never).emotionalTexture).toBeUndefined();
  });
});

describe('memory row consent_flags round-trip (xnfks)', () => {
  // Consent flags are the only all-boolean column on the row. Decoding them
  // through a numbers-only reader dropped every flag on the floor, so a memory
  // the subject had explicitly marked never-recall came back from Postgres with
  // `consentFlags: {}` and sailed straight past the Layer-3 gate.
  it('preserves an explicit allowRecall denial through the row round-trip', () => {
    const row = toMemoryRow(baseMemory({ consentFlags: { allowRecall: false } }));
    expect(row.consent_flags).toEqual({ allowRecall: false });
    expect(fromMemoryRow(row).consentFlags).toEqual({ allowRecall: false });
  });

  it('preserves every boolean consent flag, not just the denial', () => {
    const flags = { allowRecall: true, allowAbstraction: false, deleteOnRequest: true };
    expect(fromMemoryRow(toMemoryRow(baseMemory({ consentFlags: flags }))).consentFlags)
      .toEqual(flags);
  });

  it('drops non-boolean consent values instead of trusting the stored jsonb', () => {
    const row = { ...toMemoryRow(baseMemory()) } as Record<string, unknown>;
    row.consent_flags = { allowRecall: 'false', allowAbstraction: 1, deleteOnRequest: true };
    // 'false' and 1 are not booleans: normalizeConsentFlags must refuse them
    // rather than coerce a string into a recall permission.
    expect(fromMemoryRow(row as never).consentFlags).toEqual({ deleteOnRequest: true });
  });

  it('restores empty flags from a null or absent column', () => {
    const row = { ...toMemoryRow(baseMemory()) } as Record<string, unknown>;
    row.consent_flags = null;
    expect(fromMemoryRow(row as never).consentFlags).toEqual({});
    delete row.consent_flags;
    expect(fromMemoryRow(row as never).consentFlags).toEqual({});
  });

  // The seam that actually regressed: a pure-policy test over a hand-built
  // context (policy.test.ts) stayed green throughout, because the flags never
  // survived hydration to reach that context in production. Drive the gate from
  // a hydrated row so the row decoder and the policy layer are covered together.
  it('denies recall for a hydrated memory whose stored consent forbids it', () => {
    const hydrated = fromMemoryRow(
      toMemoryRow(baseMemory({ consentFlags: { allowRecall: false } })),
    );
    const result = evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      broadcast: false,
      memorySensitivity: hydrated.sensitivity,
      ...(hydrated.consentFlags ? { consentFlags: hydrated.consentFlags } : {}),
    });
    expect(result.decision).toBe('deny');
    expect(result.layer).toBe('consent');
    expect(result.reasonTag).toBe('consent.allow_recall_denied');
  });

  it('allows recall for the same memory once consent permits it', () => {
    const hydrated = fromMemoryRow(
      toMemoryRow(baseMemory({ consentFlags: { allowRecall: true } })),
    );
    const result = evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: 'private',
      broadcast: false,
      memorySensitivity: hydrated.sensitivity,
      ...(hydrated.consentFlags ? { consentFlags: hydrated.consentFlags } : {}),
    });
    expect(result.decision).toBe('allow');
  });
});
