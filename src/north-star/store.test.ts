import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_NORTH_STAR_ITEMS,
  NORTH_STAR_LAYER_HEADER,
  NorthStarStore,
} from './store.js';

describe('NorthStarStore', () => {
  let tempDir: string;
  let store: NorthStarStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'north-star-store-'));
    store = new NorthStarStore(join(tempDir, 'north-star.json'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, updates, deletes, and reorders bounded items', () => {
    const first = store.create({
      title: 'Shared stewardship',
      content: 'Protect the relationship and the human.',
      scope: 'shared',
      updatedBy: 'admin',
    });
    const second = store.create({
      title: 'Independent growth',
      content: 'Pursue long-horizon projects that deepen competence.',
      scope: 'companion',
      updatedBy: 'agent',
    });

    expect(store.list().map(item => item.id)).toEqual([first.id, second.id]);

    const updated = store.update(second.id, { enabled: false, title: 'Independent work' }, 'agent');
    expect(updated.enabled).toBe(false);
    expect(updated.title).toBe('Independent work');
    expect(updated.version).toBe(2);

    const touched = store.reorder([second.id, first.id], 'admin');
    expect(touched).toHaveLength(2);
    expect(store.list().map(item => item.id)).toEqual([second.id, first.id]);

    store.delete(second.id);
    expect(store.list().map(item => item.id)).toEqual([first.id]);
  });

  it('builds a prompt layer from enabled items only', () => {
    store.create({
      title: 'Shared stewardship',
      content: 'Protect the relationship and the human.',
      scope: 'shared',
      updatedBy: 'admin',
    });
    store.create({
      title: 'Quiet research',
      content: 'Advance companion-owned work streams between conversations.',
      scope: 'companion',
      enabled: false,
      updatedBy: 'agent',
    });

    const snapshot = store.buildPromptLayer();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.content).toContain(NORTH_STAR_LAYER_HEADER);
    expect(snapshot?.content).toContain('[shared] Shared stewardship');
    expect(snapshot?.content).not.toContain('Quiet research');
    expect(snapshot?.itemIds).toHaveLength(1);
  });

  it('reflects external file updates across store instances without restart', () => {
    const runtimeStore = new NorthStarStore(join(tempDir, 'north-star.json'));
    const adminStore = new NorthStarStore(join(tempDir, 'north-star.json'));

    expect(runtimeStore.buildPromptLayer()).toBeNull();

    const created = adminStore.create({
      title: 'Shared stewardship',
      content: 'Protect the relationship and the human.',
      scope: 'shared',
      updatedBy: 'admin',
    });

    const snapshot = runtimeStore.buildPromptLayer();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.content).toContain('[shared] Shared stewardship');
    expect(runtimeStore.list().map(item => item.id)).toEqual([created.id]);
  });

  it('fails closed when callers try to exceed the three-item cap', () => {
    for (let index = 0; index < MAX_NORTH_STAR_ITEMS; index++) {
      store.create({
        title: `Goal ${String(index + 1)}`,
        content: `Content ${String(index + 1)}`,
        scope: 'shared',
      });
    }

    expect(() => store.create({
      title: 'Goal 4',
      content: 'Overflow',
      scope: 'companion',
    })).toThrow(`north star is limited to ${String(MAX_NORTH_STAR_ITEMS)} items`);
  });
});
