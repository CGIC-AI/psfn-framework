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

import { loadSettings } from './io.js';

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
});
