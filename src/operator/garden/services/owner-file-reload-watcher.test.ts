import { describe, expect, it, vi } from 'vitest';
import { OwnerFileReloadWatcher } from './owner-file-reload-watcher.js';

function makeWatcher(reload: () => void, mtimes: Map<string, number>) {
  return new OwnerFileReloadWatcher({
    files: [{ ownerFile: 'models.json', path: '/data/models.json', reload }],
    statMtimeMs: (path) => mtimes.get(path) ?? null,
  });
}

describe('OwnerFileReloadWatcher (nudf)', () => {
  it('reloads only after the on-disk mtime changes from the startup baseline', () => {
    const reload = vi.fn();
    const mtimes = new Map<string, number>([['/data/models.json', 1000]]);
    const watcher = makeWatcher(reload, mtimes);

    watcher.start();
    // No change since baseline: no reload.
    watcher.poll();
    expect(reload).not.toHaveBeenCalled();

    // A direct disk edit bumps the mtime: exactly one reload.
    mtimes.set('/data/models.json', 2000);
    watcher.poll();
    expect(reload).toHaveBeenCalledTimes(1);

    // Same mtime again: no duplicate reload.
    watcher.poll();
    expect(reload).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('does not throw when a reload action fails, and keeps watching', () => {
    const reload = vi.fn(() => { throw new Error('reload failed'); });
    const mtimes = new Map<string, number>([['/data/models.json', 1000]]);
    const watcher = makeWatcher(reload, mtimes);
    watcher.start();

    mtimes.set('/data/models.json', 2000);
    expect(() => watcher.poll()).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);

    // A subsequent edit still triggers a reload attempt (watcher stays live).
    mtimes.set('/data/models.json', 3000);
    watcher.poll();
    expect(reload).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it('reports its watched owner files as the hot-reload coverage indicator', () => {
    const watcher = makeWatcher(vi.fn(), new Map());
    expect(watcher.watchedOwnerFiles()).toEqual(['models.json']);
  });

  it('does not treat a file that first appears after start as an edit', () => {
    const reload = vi.fn();
    const mtimes = new Map<string, number>();
    const watcher = makeWatcher(reload, mtimes);
    watcher.start(); // file absent at start -> no baseline

    mtimes.set('/data/models.json', 5000);
    watcher.poll(); // first sighting: record baseline, do not reload
    expect(reload).not.toHaveBeenCalled();

    mtimes.set('/data/models.json', 6000);
    watcher.poll(); // now a real change
    expect(reload).toHaveBeenCalledTimes(1);
    watcher.close();
  });
});
