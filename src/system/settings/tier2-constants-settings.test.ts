import { describe, it, expect } from 'vitest';
import { parseSettingsForm } from './form.js';
import { applySettings, getRuntimeSettingsSnapshot } from './runtime.js';
import type { SubstrateConfig } from '../config/runtime-config-contracts.js';

// bead zet.7 — Tier 2 tuning knobs migrated to owner settings. These assert
// fail-closed validation (bad values are rejected loudly, never silently
// clamped) and the full owner-file → SubstrateConfig → snapshot chain.

function parse(entries: Record<string, string>) {
  return parseSettingsForm(new URLSearchParams(entries));
}

const VALID = {
  subagentMaxConcurrent: '4',
  shardMaxConcurrent: '3',
  shardHeartbeatStaleAfterMs: '45000',
  shardHeartbeatDisconnectAfterMs: '120000',
  documentIngestMaxBytes: '8388608',
  documentIngestTextMaxBytes: '1048576',
  documentIngestPromptChars: '12000',
  documentIngestSidecarChars: '120000',
  imageFalTimeoutMs: '240000',
  imageFalPollIntervalMs: '2000',
  imageComfyTimeoutMs: '90000',
  imageComfyPollIntervalMs: '1000',
} as const;

describe('Tier 2 tuning knobs — form validation (fail closed)', () => {
  it('accepts in-range values and parses them as integers', () => {
    const [settings, errors] = parse({ ...VALID });
    expect(errors).toEqual([]);
    expect(settings.subagentMaxConcurrent).toBe(4);
    expect(settings.shardMaxConcurrent).toBe(3);
    expect(settings.shardHeartbeatStaleAfterMs).toBe(45_000);
    expect(settings.shardHeartbeatDisconnectAfterMs).toBe(120_000);
    expect(settings.documentIngestMaxBytes).toBe(8_388_608);
    expect(settings.documentIngestTextMaxBytes).toBe(1_048_576);
    expect(settings.documentIngestPromptChars).toBe(12_000);
    expect(settings.documentIngestSidecarChars).toBe(120_000);
    expect(settings.imageFalTimeoutMs).toBe(240_000);
    expect(settings.imageFalPollIntervalMs).toBe(2_000);
    expect(settings.imageComfyTimeoutMs).toBe(90_000);
    expect(settings.imageComfyPollIntervalMs).toBe(1_000);
  });

  it.each([
    ['subagentMaxConcurrent', '0'],
    ['subagentMaxConcurrent', '1000'],
    ['shardMaxConcurrent', '0'],
    ['shardHeartbeatStaleAfterMs', '100'],
    ['shardHeartbeatDisconnectAfterMs', '100'],
    // Above the API transport ceiling (16 MiB decoded file part).
    ['documentIngestMaxBytes', '33554432'],
    ['documentIngestTextMaxBytes', '10'],
    ['documentIngestPromptChars', '5'],
    ['documentIngestSidecarChars', '5'],
    ['imageFalTimeoutMs', '10'],
    ['imageFalPollIntervalMs', '1'],
    ['imageComfyTimeoutMs', '10'],
    ['imageComfyPollIntervalMs', '999999'],
  ])('rejects out-of-range %s=%s loudly (no silent clamp)', (field, value) => {
    const [, errors] = parse({ [field]: value });
    expect(errors.some((err) => err.includes(field))).toBe(true);
  });
});

describe('Tier 2 tuning knobs — owner-file → config → snapshot wiring', () => {
  it('threads operator values into SubstrateConfig and back out through the snapshot', () => {
    const [settings, errors] = parse({ ...VALID });
    expect(errors).toEqual([]);

    const config = {} as SubstrateConfig;
    applySettings(config, settings);

    expect(config.subagentMaxConcurrent).toBe(4);
    expect(config.shardMaxConcurrent).toBe(3);
    expect(config.shardHeartbeatStaleAfterMs).toBe(45_000);
    expect(config.shardHeartbeatDisconnectAfterMs).toBe(120_000);
    expect(config.documentIngestMaxBytes).toBe(8_388_608);
    expect(config.documentIngestTextMaxBytes).toBe(1_048_576);
    expect(config.documentIngestPromptChars).toBe(12_000);
    expect(config.documentIngestSidecarChars).toBe(120_000);
    expect(config.imageFalTimeoutMs).toBe(240_000);
    expect(config.imageFalPollIntervalMs).toBe(2_000);
    expect(config.imageComfyTimeoutMs).toBe(90_000);
    expect(config.imageComfyPollIntervalMs).toBe(1_000);

    const snapshot = getRuntimeSettingsSnapshot(config);
    expect(snapshot.subagentMaxConcurrent).toBe(4);
    expect(snapshot.shardMaxConcurrent).toBe(3);
    expect(snapshot.shardHeartbeatStaleAfterMs).toBe(45_000);
    expect(snapshot.shardHeartbeatDisconnectAfterMs).toBe(120_000);
    expect(snapshot.documentIngestMaxBytes).toBe(8_388_608);
    expect(snapshot.documentIngestTextMaxBytes).toBe(1_048_576);
    expect(snapshot.documentIngestPromptChars).toBe(12_000);
    expect(snapshot.documentIngestSidecarChars).toBe(120_000);
    expect(snapshot.imageFalTimeoutMs).toBe(240_000);
    expect(snapshot.imageFalPollIntervalMs).toBe(2_000);
    expect(snapshot.imageComfyTimeoutMs).toBe(90_000);
    expect(snapshot.imageComfyPollIntervalMs).toBe(1_000);
  });
});
