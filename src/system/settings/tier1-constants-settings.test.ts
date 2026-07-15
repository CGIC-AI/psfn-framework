import { describe, it, expect } from 'vitest';
import { parseSettingsForm } from './form.js';
import { applySettings, getRuntimeSettingsSnapshot } from './runtime.js';
import type { SubstrateConfig } from '../config/runtime-config-contracts.js';

// bead zet.6 — Tier 1 non-memory policy constants migrated to owner settings.
// These assert fail-closed validation (bad values are rejected loudly, never
// silently clamped) and the full owner-file → SubstrateConfig → snapshot chain.

function parse(entries: Record<string, string>) {
  return parseSettingsForm(new URLSearchParams(entries));
}

const VALID = {
  analysisWorkbenchExecutionTimeoutMs: '8000',
  analysisWorkbenchOutputTruncation: '16384',
  voiceSessionTimeoutMs: '60000',
  voiceMaxFrameBytes: '524288',
  voiceMaxPendingFrames: '16',
} as const;

describe('Tier 1 non-memory settings — form validation (fail closed)', () => {
  it('accepts in-range values and parses them as integers', () => {
    const [settings, errors] = parse({ ...VALID });
    expect(errors).toEqual([]);
    expect(settings.analysisWorkbenchExecutionTimeoutMs).toBe(8000);
    expect(settings.analysisWorkbenchOutputTruncation).toBe(16384);
    expect(settings.voiceSessionTimeoutMs).toBe(60000);
    expect(settings.voiceMaxFrameBytes).toBe(524288);
    expect(settings.voiceMaxPendingFrames).toBe(16);
  });

  it.each([
    ['analysisWorkbenchExecutionTimeoutMs', '10'],
    ['analysisWorkbenchExecutionTimeoutMs', '9999999'],
    ['analysisWorkbenchOutputTruncation', '1'],
    ['voiceSessionTimeoutMs', '100'],
    ['voiceMaxFrameBytes', '10'],
    ['voiceMaxPendingFrames', '0'],
    ['voiceMaxPendingFrames', '99999'],
  ])('rejects out-of-range %s=%s loudly (no silent clamp)', (field, value) => {
    const [, errors] = parse({ [field]: value });
    expect(errors.some((err) => err.includes(field))).toBe(true);
  });
});

describe('Tier 1 non-memory settings — owner-file → config → snapshot wiring', () => {
  it('threads operator values into SubstrateConfig and back out through the snapshot', () => {
    const [settings, errors] = parse({ ...VALID });
    expect(errors).toEqual([]);

    const config = {} as SubstrateConfig;
    applySettings(config, settings);

    expect(config.analysisWorkbenchExecutionTimeoutMs).toBe(8000);
    expect(config.analysisWorkbenchOutputTruncation).toBe(16384);
    expect(config.voiceSessionTimeoutMs).toBe(60000);
    expect(config.voiceMaxFrameBytes).toBe(524288);
    expect(config.voiceMaxPendingFrames).toBe(16);

    const snapshot = getRuntimeSettingsSnapshot(config);
    expect(snapshot.analysisWorkbenchExecutionTimeoutMs).toBe(8000);
    expect(snapshot.analysisWorkbenchOutputTruncation).toBe(16384);
    expect(snapshot.voiceSessionTimeoutMs).toBe(60000);
    expect(snapshot.voiceMaxFrameBytes).toBe(524288);
    expect(snapshot.voiceMaxPendingFrames).toBe(16);
  });
});
