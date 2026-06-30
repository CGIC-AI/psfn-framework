import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FOUNDATION_SECTION_DEFINITIONS } from './foundation-sections.js';
import { composeSystemPromptTemplate } from './loader.js';
import { PromptLayerStore } from './prompt-store.js';
import {
  composeDefaultSystemLanguageLayerContent,
  ensureSystemLanguagePromptLayer,
  SYSTEM_LANGUAGE_LAYER_IDENTIFIER,
} from './system-language.js';

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

describe('PromptLayerStore', () => {
  let tmpDir: string;
  let filePath: string;
  let historyPath: string;
  let store: PromptLayerStore;

  function foundationLayers() {
    return store.getByType('base')
      .filter(layer => layer.name.startsWith('Character Foundation'));
  }

  function composeEnabledFoundationPrompt(): string {
    return foundationLayers()
      .filter(layer => layer.enabled)
      .sort((left, right) => (left.promptOrder ?? 0) - (right.promptOrder ?? 0))
      .map(layer => layer.content)
      .join('\n\n');
  }

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

  describe('load migrations', () => {
    function writeSystemLanguageLayer(
      content: string,
      updatedBy = 'system',
      order: { priority?: number; promptOrder?: number } = {},
    ): void {
      writeFileSync(filePath, JSON.stringify([{
        id: 'system-language-layer',
        type: 'system_language',
        name: 'System Language Templates',
        identifier: SYSTEM_LANGUAGE_LAYER_IDENTIFIER,
        role: 'system',
        promptOrder: order.promptOrder ?? 880,
        content,
        enabled: true,
        priority: order.priority ?? 880,
        updatedAt: '2026-06-29T00:00:00.000Z',
        updatedBy,
        checksum: checksum(content),
        version: 1,
      }], null, 2));
    }

    it('loads and migrates persisted system_language layers with retired substrate health template keys', () => {
      const payload = JSON.parse(composeDefaultSystemLanguageLayerContent()) as {
        templates: Record<string, string>;
      };
      payload.templates['substrate_health.header'] = '[Substrate health]';
      payload.templates['substrate_health.overall.healthy'] = 'healthy';
      payload.templates['substrate_health.overall.degraded'] = 'degraded';
      payload.templates['substrate_health.overall.unavailable'] = '{{unavailable_reason}}';
      payload.templates['substrate_health.subsystem_missing_probe'] = 'missing';
      payload.templates['substrate_health.subsystem_degraded_suffix'] = 'degraded';
      payload.templates['substrate_health.gateway_degraded_suffix'] = 'gateway';
      writeSystemLanguageLayer(JSON.stringify(payload, null, 2), 'system', {
        priority: 44,
        promptOrder: 45,
      });

      const migratedStore = new PromptLayerStore(filePath, historyPath);
      const loaded = migratedStore.getById('system-language-layer');

      expect(loaded?.content).toBe(composeDefaultSystemLanguageLayerContent());
      expect(loaded?.content).not.toContain('substrate_health');
      expect(loaded?.version).toBe(2);
      expect(loaded?.updatedBy).toBe('system:migration:prompt-layer-store');
      expect(loaded?.priority).toBe(44);
      expect(loaded?.promptOrder).toBe(45);
      expect(readFileSync(filePath, 'utf-8')).not.toContain('substrate_health');
      expect(readFileSync(historyPath, 'utf-8')).toContain('2026-06-30-system-language-retired-template-keys');
    });

    it('still rejects arbitrary unknown system_language template keys', () => {
      const payload = JSON.parse(composeDefaultSystemLanguageLayerContent()) as {
        templates: Record<string, string>;
      };
      payload.templates['debug.unowned_template'] = 'should fail';
      writeSystemLanguageLayer(JSON.stringify(payload, null, 2));

      expect(() => new PromptLayerStore(filePath, historyPath)).toThrow('unknown template key "debug.unowned_template"');
    });

    it('lets seed normalization rewrite migrated system-owned system_language layers', () => {
      const payload = JSON.parse(composeDefaultSystemLanguageLayerContent()) as {
        templates: Record<string, string>;
      };
      payload.templates['compaction.header'] = '[Previous summary from old system default]';
      payload.templates['substrate_health.header'] = '[Substrate health]';
      writeSystemLanguageLayer(JSON.stringify(payload, null, 2));

      const migratedStore = new PromptLayerStore(filePath, historyPath);
      const normalized = ensureSystemLanguagePromptLayer(migratedStore);

      expect(normalized.content).toBe(composeDefaultSystemLanguageLayerContent());
      expect(normalized.content).not.toContain('substrate_health');
      expect(normalized.updatedBy).toBe('system:system-language-seed');
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

    it('updates metadata fields when provided', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      const updated = store.update(layer.id, 'v2', 'admin', {
        identifier: 'runtime.main',
        role: 'assistant',
        promptOrder: 4,
      });

      expect(updated.identifier).toBe('runtime.main');
      expect(updated.role).toBe('assistant');
      expect(updated.promptOrder).toBe(4);
    });

    it('allows clearing optional metadata fields', () => {
      const layer = store.create({
        type: 'runtime',
        name: 'Test',
        content: 'v1',
        identifier: 'runtime.main',
        role: 'assistant',
        promptOrder: 2,
      });

      const updated = store.update(layer.id, 'v2', 'admin', {
        identifier: '   ',
        role: undefined,
        promptOrder: undefined,
      });

      expect(updated.identifier).toBeUndefined();
      expect(updated.role).toBeUndefined();
      expect(updated.promptOrder).toBeUndefined();
    });

    it('preserves content for metadata-only patch updates', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'seed-content' });

      const updated = store.update(layer.id, {
        metadata: {
          identifier: 'runtime.main',
          role: 'assistant',
          promptOrder: 3,
        },
      }, 'admin');

      expect(updated.content).toBe('seed-content');
      expect(updated.identifier).toBe('runtime.main');
      expect(updated.role).toBe('assistant');
      expect(updated.promptOrder).toBe(3);
    });

    it('preserves content for priority-only patch updates', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'seed-content', priority: 9 });

      const updated = store.update(layer.id, { priority: 1 }, 'admin');

      expect(updated.content).toBe('seed-content');
      expect(updated.priority).toBe(1);
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

    it('persists optional reason in history entries', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      store.update(layer.id, 'v2', 'admin', {}, 'Clarify behavioral guardrail');

      const history = store.getLayerHistory(layer.id);
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('Clarify behavioral guardrail');
    });

    it('throws for unknown layer', () => {
      expect(() => store.update('nonexistent', 'content', 'admin')).toThrow('Prompt layer not found');
    });

    it('throws and preserves the layer when history persistence fails', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      mkdirSync(historyPath, { recursive: true });

      expect(() => store.update(layer.id, 'v2', 'admin')).toThrow(
        `Failed to write prompt history to ${historyPath}:`,
      );
      expect(store.getById(layer.id)).toMatchObject({
        content: 'v1',
        version: 1,
        updatedBy: 'system',
      });
    });

    it('validates role enum values', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      expect(() => store.update(layer.id, 'v2', 'admin', { role: 'bad' as any })).toThrow('Invalid prompt role');
    });

    it('validates promptOrder as integer >= 0', () => {
      const layer = store.create({ type: 'runtime', name: 'Test', content: 'v1' });
      expect(() => store.update(layer.id, 'v2', 'admin', { promptOrder: -1 })).toThrow('promptOrder must be an integer >= 0');
      expect(() => store.update(layer.id, 'v2', 'admin', { promptOrder: 1.5 })).toThrow('promptOrder must be an integer >= 0');
    });
  });

  describe('reorderByLayerIds()', () => {
    it('reorders priorities and promptOrder in one pass without mutating content', () => {
      const a = store.create({ type: 'runtime', name: 'A', content: 'alpha', priority: 10, promptOrder: 10, identifier: 'runtime.a' });
      const b = store.create({ type: 'runtime', name: 'B', content: 'bravo', priority: 20, promptOrder: 20, identifier: 'runtime.b' });
      const c = store.create({ type: 'runtime', name: 'C', content: 'charlie', priority: 30, promptOrder: 30, identifier: 'runtime.c' });

      const touched = store.reorderByLayerIds([c.id, a.id, b.id], 'admin');

      expect(touched).toHaveLength(3);
      expect(store.getById(c.id)?.priority).toBe(0);
      expect(store.getById(a.id)?.priority).toBe(1);
      expect(store.getById(b.id)?.priority).toBe(2);
      expect(store.getById(c.id)?.promptOrder).toBe(0);
      expect(store.getById(a.id)?.promptOrder).toBe(1);
      expect(store.getById(b.id)?.promptOrder).toBe(2);
      expect(store.getById(a.id)?.content).toBe('alpha');
      expect(store.getById(b.id)?.content).toBe('bravo');
      expect(store.getById(c.id)?.content).toBe('charlie');
    });

    it('persists the requested layer order exactly', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'base', priority: 0, promptOrder: 0, identifier: 'main' });
      const runtimeA = store.create({ type: 'runtime', name: 'Runtime A', content: 'runtime-a', priority: 10, promptOrder: 10, identifier: 'runtime.a' });
      const runtimeB = store.create({ type: 'runtime', name: 'Runtime B', content: 'runtime-b', priority: 20, promptOrder: 20, identifier: 'runtime.b' });

      store.reorderByLayerIds([runtimeB.id, base.id, runtimeA.id], 'admin');

      expect(store.getAll().map(layer => layer.id)).toEqual([runtimeB.id, base.id, runtimeA.id]);
      expect(store.getById(runtimeB.id)?.priority).toBe(0);
      expect(store.getById(base.id)?.priority).toBe(1);
      expect(store.getById(runtimeA.id)?.priority).toBe(2);
      expect(store.getById(runtimeB.id)?.promptOrder).toBe(0);
      expect(store.getById(base.id)?.promptOrder).toBe(1);
      expect(store.getById(runtimeA.id)?.promptOrder).toBe(2);
    });

    it('requires the full layer-id set exactly once', () => {
      const a = store.create({ type: 'runtime', name: 'A', content: 'alpha' });
      const b = store.create({ type: 'runtime', name: 'B', content: 'bravo' });

      expect(() => store.reorderByLayerIds([a.id], 'admin')).toThrow('layerIds must include every prompt layer exactly once');
      expect(() => store.reorderByLayerIds([a.id, a.id], 'admin')).toThrow('Duplicate layer id');
      expect(() => store.reorderByLayerIds([a.id, 'missing'], 'admin')).toThrow('Prompt layer not found');
      expect(store.getById(b.id)?.content).toBe('bravo');
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
      const foundationTemplate = composeSystemPromptTemplate();
      store.seedFromCharacterCard(foundationTemplate);

      const layers = foundationLayers();
      expect(layers).toHaveLength(FOUNDATION_SECTION_DEFINITIONS.length);
      expect(layers.every(layer => layer.type === 'base')).toBe(true);
      expect(composeEnabledFoundationPrompt()).toBe(foundationTemplate);
      expect(layers[0]?.identifier).toBe('main');
      expect(layers[0]?.role).toBe('system');
      expect(layers[0]?.promptOrder).toBe(0);
    });

    it('skips seeding when layers already exist', () => {
      const foundationTemplate = composeSystemPromptTemplate();
      store.create({ type: 'base', name: 'Existing', content: 'existing' });
      store.seedFromCharacterCard(foundationTemplate);

      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].name).toBe('Existing');
    });

    it('refreshes untouched system Character Foundation when current card prompt differs', () => {
      const foundationTemplate = composeSystemPromptTemplate();
      const base = store.create({
        type: 'base',
        name: 'Character Foundation',
        content: 'You are PSFN.',
        updatedBy: 'system',
      });

      store.seedFromCharacterCard(foundationTemplate);

      const refreshed = store.getById(base.id)!;
      expect(refreshed.content).toBe(foundationTemplate);
      expect(refreshed.content).toContain('{{description}}');
      expect(refreshed.content).not.toContain('PSFN');
      expect(refreshed.updatedBy).toBe('system:seed-sync');
      expect(refreshed.version).toBe(2);

      const history = store.getLayerHistory(base.id);
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('Refresh untouched Character Foundation from current character card');
    });

    it('upgrades untouched legacy system seed with frozen User token', () => {
      store.create({
        type: 'base',
        name: 'Character Foundation',
        content: 'You are PSFN.\nHello User.',
        updatedBy: 'system',
      });

      store.seedFromCharacterCard('You are PSFN.\nHello {{user}}.');

      const upgraded = store.getAll()[0];
      expect(upgraded.identifier).toBe('main');
      expect(upgraded.role).toBe('system');
      expect(upgraded.promptOrder).toBe(0);
      expect(upgraded.content).toContain('{{user}}');
      expect(upgraded.updatedBy).toBe('system:migrate-user-token');
      expect(upgraded.version).toBe(2);
    });

    it('preserves moved Character Foundation section order during metadata normalization', () => {
      const foundationTemplate = composeSystemPromptTemplate();
      store.seedFromCharacterCard(foundationTemplate);
      const identityLayer = foundationLayers().find(layer => layer.identifier === 'main')!;
      store.update(identityLayer.id, {
        name: 'Old Identity Layer Name',
        priority: 777,
        metadata: {
          promptOrder: 778,
        },
      }, 'admin');

      store.seedFromCharacterCard(foundationTemplate);

      const normalized = store.getById(identityLayer.id)!;
      expect(normalized.name).toBe('Character Foundation · Identity');
      expect(normalized.priority).toBe(777);
      expect(normalized.promptOrder).toBe(778);
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

    it('rolls back target layer from large mixed history', () => {
      const target = store.create({ type: 'runtime', name: 'Target', content: 'v1' });
      const noisy = store.create({ type: 'runtime', name: 'Noisy', content: 'n0' });

      store.update(target.id, 'v2', 'admin');
      for (let i = 1; i <= 400; i++) {
        store.update(noisy.id, `n${i}`, 'admin');
      }

      const rolled = store.rollback(target.id, 1);
      expect(rolled.content).toBe('v1');
    });
  });

  describe('getHistory() / getLayerHistory()', () => {
    it('returns empty when no history', () => {
      expect(store.getHistory()).toEqual([]);
    });

    it('recovers valid history lines when JSONL contains corrupt entries', () => {
      const layer = store.create({ type: 'runtime', name: 'A', content: 'a1' });
      store.update(layer.id, 'a2', 'admin');
      store.update(layer.id, 'a3', 'admin');

      const historyLines = readFileSync(historyPath, 'utf-8').trimEnd().split('\n');
      expect(historyLines).toHaveLength(2);

      writeFileSync(
        historyPath,
        `${historyLines[0]}\n{"layerId":"bad-schema"}\n{not-json\n${historyLines[1]}\n`,
        'utf-8',
      );

      const recovered = store.getLayerHistory(layer.id);
      expect(recovered).toHaveLength(2);
      expect(recovered[0].newContent).toBe('a2');
      expect(recovered[1].newContent).toBe('a3');

      const rolledBack = store.rollback(layer.id, 1);
      expect(rolledBack.content).toBe('a1');
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

    it('throws when existing prompt layers JSON is malformed', () => {
      writeFileSync(filePath, '{"broken":', 'utf-8');

      expect(() => new PromptLayerStore(filePath, historyPath)).toThrow(
        `Failed to load prompt layers from ${filePath}:`,
      );
    });

    it('throws when existing prompt layers data is structurally invalid', () => {
      writeFileSync(filePath, JSON.stringify([{
        id: 'layer-1',
        type: 'base',
        name: 'Base',
        content: 'persisted content',
        enabled: true,
        priority: 0,
        updatedAt: '2026-03-08T00:00:00.000Z',
        updatedBy: 'system',
        checksum: 'bad-checksum',
        version: 1,
      }]), 'utf-8');

      expect(() => new PromptLayerStore(filePath, historyPath)).toThrow(
        `Failed to load prompt layers from ${filePath}: layers[0].checksum does not match content`,
      );
    });
  });
});
