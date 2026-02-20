import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from './prompt-store.js';

describe('PromptLayerStore', () => {
  let tmpDir: string;
  let filePath: string;
  let historyPath: string;
  let store: PromptLayerStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-'));
    filePath = join(tmpDir, 'prompt-layers.json');
    historyPath = join(tmpDir, 'prompt-history.jsonl');
    store = new PromptLayerStore(filePath, historyPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create()', () => {
    it('creates a layer with UUID, checksum, and version 1', () => {
      const layer = store.create({
        type: 'base',
        name: 'Test Base',
        content: 'You are a helpful assistant.',
      });

      expect(layer.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(layer.type).toBe('base');
      expect(layer.name).toBe('Test Base');
      expect(layer.content).toBe('You are a helpful assistant.');
      expect(layer.enabled).toBe(true);
      expect(layer.priority).toBe(0);
      expect(layer.version).toBe(1);
      expect(layer.checksum).toHaveLength(16);
      expect(layer.updatedBy).toBe('system');
      expect(layer.updatedAt).toBeTruthy();
    });

    it('persists to JSON file via atomic write', () => {
      store.create({ type: 'base', name: 'Test', content: 'content' });

      expect(existsSync(filePath)).toBe(true);
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('Test');
    });

    it('accepts optional fields', () => {
      const layer = store.create({
        type: 'channel',
        name: 'Discord',
        content: 'Discord context',
        priority: 5,
        channelType: 'discord_text',
        updatedBy: 'admin',
      });

      expect(layer.priority).toBe(5);
      expect(layer.channelType).toBe('discord_text');
      expect(layer.updatedBy).toBe('admin');
    });

    it('accepts taskKind for task layers', () => {
      const layer = store.create({
        type: 'task',
        name: 'Heartbeat',
        content: 'Heartbeat context',
        taskKind: 'heartbeat',
      });

      expect(layer.taskKind).toBe('heartbeat');
    });
  });

  describe('getAll()', () => {
    it('returns empty array when no layers exist', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('returns all layers', () => {
      store.create({ type: 'base', name: 'A', content: 'a' });
      store.create({ type: 'operator', name: 'B', content: 'b' });

      expect(store.getAll()).toHaveLength(2);
    });

    it('returns a copy (not the internal array)', () => {
      store.create({ type: 'base', name: 'A', content: 'a' });
      const all = store.getAll();
      all.push(null as any);
      expect(store.getAll()).toHaveLength(1);
    });
  });

  describe('getById()', () => {
    it('returns the correct layer', () => {
      const layer = store.create({ type: 'base', name: 'Test', content: 'test' });
      const found = store.getById(layer.id);
      expect(found?.name).toBe('Test');
    });

    it('returns undefined for unknown id', () => {
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('getByType()', () => {
    it('filters layers by type', () => {
      store.create({ type: 'base', name: 'A', content: 'a' });
      store.create({ type: 'operator', name: 'B', content: 'b' });
      store.create({ type: 'base', name: 'C', content: 'c' });

      const bases = store.getByType('base');
      expect(bases).toHaveLength(2);
      expect(bases.every(l => l.type === 'base')).toBe(true);
    });
  });

  describe('update()', () => {
    it('increments version and updates checksum', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      const oldChecksum = layer.checksum;

      const updated = store.update(layer.id, 'v2', 'admin');

      expect(updated.version).toBe(2);
      expect(updated.content).toBe('v2');
      expect(updated.checksum).not.toBe(oldChecksum);
      expect(updated.updatedBy).toBe('admin');
    });

    it('writes history entry', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      store.update(layer.id, 'v2', 'admin');

      const history = store.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].layerId).toBe(layer.id);
      expect(history[0].previousContent).toBe('v1');
      expect(history[0].newContent).toBe('v2');
      expect(history[0].version).toBe(1); // version at time of change
    });

    it('throws for unknown layer', () => {
      expect(() => store.update('nonexistent', 'content', 'admin')).toThrow('Prompt layer not found');
    });
  });

  describe('toggle()', () => {
    it('flips enabled state', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'test' });
      expect(layer.enabled).toBe(true);

      const toggled = store.toggle(layer.id);
      expect(toggled.enabled).toBe(false);

      const toggled2 = store.toggle(layer.id);
      expect(toggled2.enabled).toBe(true);
    });

    it('prevents disabling the only base layer', () => {
      const layer = store.create({ type: 'base', name: 'Only Base', content: 'base' });

      expect(() => store.toggle(layer.id)).toThrow('Cannot disable the only enabled base layer');
    });

    it('allows disabling a base layer if another enabled base exists', () => {
      const layer1 = store.create({ type: 'base', name: 'Base 1', content: 'base1' });
      store.create({ type: 'base', name: 'Base 2', content: 'base2' });

      const toggled = store.toggle(layer1.id);
      expect(toggled.enabled).toBe(false);
    });

    it('throws for unknown layer', () => {
      expect(() => store.toggle('nonexistent')).toThrow('Prompt layer not found');
    });
  });

  describe('delete()', () => {
    it('removes a layer', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'test' });
      expect(store.getAll()).toHaveLength(1);

      store.delete(layer.id);
      expect(store.getAll()).toHaveLength(0);
    });

    it('prevents deleting the only base layer', () => {
      const layer = store.create({ type: 'base', name: 'Only Base', content: 'base' });

      expect(() => store.delete(layer.id)).toThrow('Cannot delete the only base layer');
    });

    it('allows deleting a base layer if another base exists', () => {
      const layer1 = store.create({ type: 'base', name: 'Base 1', content: 'base1' });
      store.create({ type: 'base', name: 'Base 2', content: 'base2' });

      store.delete(layer1.id);
      expect(store.getAll()).toHaveLength(1);
    });

    it('throws for unknown layer', () => {
      expect(() => store.delete('nonexistent')).toThrow('Prompt layer not found');
    });
  });

  describe('seedFromCharacterCard()', () => {
    it('seeds when store is empty', () => {
      store.seedFromCharacterCard('You are Purrsephone.');

      const layers = store.getAll();
      expect(layers).toHaveLength(1);
      expect(layers[0].type).toBe('base');
      expect(layers[0].name).toBe('Character Foundation');
      expect(layers[0].content).toBe('You are Purrsephone.');
      expect(layers[0].identifier).toBe('main');
      expect(layers[0].role).toBe('system');
    });

    it('skips seeding when layers already exist', () => {
      store.create({ type: 'base', name: 'Existing', content: 'existing' });
      store.seedFromCharacterCard('You are Purrsephone.');

      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].name).toBe('Existing');
    });

    it('upgrades untouched legacy system seed with frozen User token', () => {
      store.create({
        type: 'base',
        name: 'Character Foundation',
        content: 'You are Purrsephone.\nHello User.',
        updatedBy: 'system',
      });

      store.seedFromCharacterCard('You are Purrsephone.\nHello {{user}}.');

      const upgraded = store.getAll()[0];
      expect(upgraded.identifier).toBe('main');
      expect(upgraded.role).toBe('system');
      expect(upgraded.content).toContain('{{user}}');
      expect(upgraded.updatedBy).toBe('system:migrate-user-token');
      expect(upgraded.version).toBe(2);
    });
  });

  describe('rollback()', () => {
    it('restores previous content from history', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      store.update(layer.id, 'v2', 'admin');
      store.update(layer.id, 'v3', 'admin');

      // Rollback to version 1 (restores 'v1' content)
      const rolledBack = store.rollback(layer.id, 1);
      expect(rolledBack.content).toBe('v1');
      expect(rolledBack.version).toBe(4); // version increments on rollback
    });

    it('throws for unknown version', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      expect(() => store.rollback(layer.id, 99)).toThrow('No history entry');
    });
  });

  describe('getHistory() / getLayerHistory()', () => {
    it('returns empty when no history', () => {
      expect(store.getHistory()).toEqual([]);
    });

    it('filters history by layer id', () => {
      const layer1 = store.create({ type: 'runtime', name: 'A', content: 'a' });
      const layer2 = store.create({ type: 'runtime', name: 'B', content: 'b' });

      store.update(layer1.id, 'a2', 'admin');
      store.update(layer2.id, 'b2', 'admin');

      const history1 = store.getLayerHistory(layer1.id);
      expect(history1).toHaveLength(1);
      expect(history1[0].layerName).toBe('A');

      const history2 = store.getLayerHistory(layer2.id);
      expect(history2).toHaveLength(1);
      expect(history2[0].layerName).toBe('B');
    });
  });

  describe('count', () => {
    it('returns the number of layers', () => {
      expect(store.count).toBe(0);
      store.create({ type: 'base', name: 'A', content: 'a' });
      expect(store.count).toBe(1);
      store.create({ type: 'operator', name: 'B', content: 'b' });
      expect(store.count).toBe(2);
    });
  });

  describe('persistence', () => {
    it('loads layers from existing file on construction', () => {
      store.create({ type: 'base', name: 'Persisted', content: 'persisted content' });

      // Create a new store instance pointing to same file
      const store2 = new PromptLayerStore(filePath, historyPath);
      expect(store2.getAll()).toHaveLength(1);
      expect(store2.getAll()[0].name).toBe('Persisted');
    });

    it('uses atomic write (tmp + rename)', () => {
      store.create({ type: 'base', name: 'Test', content: 'test' });

      // The .tmp file should not exist after save completes
      expect(existsSync(filePath + '.tmp')).toBe(false);
      // But the actual file should
      expect(existsSync(filePath)).toBe(true);
    });
  });
});
