import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock('../../shared/logger.js', () => ({
  createComponentLogger: () => ({
    info: loggerSpies.info,
  }),
}));

import { loadSettings, saveSettings } from './io.js';

describe('settings owner-file load logging', () => {
  const roots: string[] = [];

  afterEach(() => {
    loggerSpies.info.mockClear();
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('logs only when settings are read from disk, not on a cache hit', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-log-'));
    roots.push(root);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf-8');

    loadSettings(root);
    loadSettings(root);

    expect(loggerSpies.info).toHaveBeenCalledTimes(1);
    expect(loggerSpies.info).toHaveBeenCalledWith('Loaded saved settings');
  });

  it('strictly validates the settings-owned wiki startup hydration group', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-wiki-hydration-'));
    roots.push(root);
    const invalidRoot = mkdtempSync(join(tmpdir(), 'psfn-settings-wiki-hydration-invalid-'));
    roots.push(invalidRoot);
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      wikiStartupHydration: {
        recentSessionLimit: 4,
        recentMessageLimit: 18,
        maxContextChars: 6_000,
      },
    }), 'utf-8');

    expect(loadSettings(root).wikiStartupHydration).toEqual({
      recentSessionLimit: 4,
      recentMessageLimit: 18,
      maxContextChars: 6_000,
    });

    writeFileSync(join(invalidRoot, 'settings.json'), JSON.stringify({
      wikiStartupHydration: {
        recentSessionLimit: 0,
        recentMessageLimit: 18,
        maxContextChars: 6_000,
        fallbackLimit: 4,
      },
    }), 'utf-8');

    expect(() => loadSettings(invalidRoot)).toThrow(/unknown keys: fallbackLimit/u);
  });

  it('round-trips and strictly validates committed voice segmenter thresholds', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-voice-segmenter-'));
    roots.push(root);
    saveSettings(root, {
      voiceReplySegmenter: {
        minSegmentLength: 24,
        maxBufferLength: 240,
      },
    });
    expect(loadSettings(root).voiceReplySegmenter).toEqual({
      minSegmentLength: 24,
      maxBufferLength: 240,
    });

    const invalidRoot = mkdtempSync(join(tmpdir(), 'psfn-settings-voice-segmenter-invalid-'));
    roots.push(invalidRoot);
    writeFileSync(join(invalidRoot, 'settings.json'), JSON.stringify({
      voiceReplySegmenter: {
        minSegmentLength: 240,
        maxBufferLength: 24,
      },
    }), 'utf-8');
    expect(() => loadSettings(invalidRoot)).toThrow(
      'must be greater than voiceReplySegmenter.minSegmentLength',
    );
  });

  it('round-trips and strictly validates lifecycle Kubernetes operational policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-settings-lifecycle-kube-'));
    roots.push(root);
    const lifecycleKubernetes = {
      lifecycleCommandTimeoutMs: 30_000,
      operatorCommandTimeoutMs: 600_000,
      operatorHttpTimeoutMs: 8_000,
      operatorConfirmationRequestTimeoutMs: 5_000,
      kubernetesReadRequestTimeoutMs: 5_000,
      kubernetesRolloutRequestTimeoutMs: 5_000,
      rolloutWaitTimeoutMs: 180_000,
      rolloutPollIntervalMs: 3_000,
      rollbackWaitTimeoutMs: 180_000,
      rollbackPollIntervalMs: 3_000,
      postRolloutMaxLogRecords: 10,
      postRolloutValidationHistoryLimit: 20,
      rollbackHistoryLimit: 50,
    };
    saveSettings(root, { lifecycleKubernetes });
    expect(loadSettings(root).lifecycleKubernetes).toEqual(lifecycleKubernetes);

    const invalidRoot = mkdtempSync(join(tmpdir(), 'psfn-settings-lifecycle-kube-invalid-'));
    roots.push(invalidRoot);
    writeFileSync(join(invalidRoot, 'settings.json'), JSON.stringify({
      lifecycleKubernetes: {
        ...lifecycleKubernetes,
        rolloutPollIntervalMs: 180_001,
        unownedFallbackTimeoutMs: 5_000,
      },
    }), 'utf-8');
    expect(() => loadSettings(invalidRoot)).toThrow(
      /unknown keys: unownedFallbackTimeoutMs/u,
    );

    const incoherentRoot = mkdtempSync(join(tmpdir(), 'psfn-settings-lifecycle-kube-incoherent-'));
    roots.push(incoherentRoot);
    writeFileSync(join(incoherentRoot, 'settings.json'), JSON.stringify({
      lifecycleKubernetes: {
        ...lifecycleKubernetes,
        rollbackPollIntervalMs: 180_001,
      },
    }), 'utf-8');
    expect(() => loadSettings(incoherentRoot)).toThrow(
      'must not exceed lifecycleKubernetes.rollbackWaitTimeoutMs',
    );
  });
});
