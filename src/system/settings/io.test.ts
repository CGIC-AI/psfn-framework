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
});
