import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from './prompt-store.js';
import { PromptComposer } from './prompt-composer.js';

describe('PromptComposer', () => {
  let tmpDir: string;
  let store: PromptLayerStore;
  let composer: PromptComposer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-composer-'));
    store = new PromptLayerStore(
      join(tmpDir, 'layers.json'),
      join(tmpDir, 'history.jsonl'),
    );
    composer = new PromptComposer(store);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('layer ordering', () => {
    it('orders base before operator before runtime', () => {
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'operator', name: 'Operator', content: 'OPERATOR' });

      const result = composer.compose();
      const parts = result.text.split('\n\n');

      expect(parts[0]).toBe('BASE');
      expect(parts[1]).toBe('OPERATOR');
      expect(parts[2]).toBe('RUNTIME');
    });

    it('sorts by priority within same type', () => {
      store.create({ type: 'runtime', name: 'Second', content: 'SECOND', priority: 10 });
      store.create({ type: 'runtime', name: 'First', content: 'FIRST', priority: 1 });
      store.create({ type: 'runtime', name: 'Third', content: 'THIRD', priority: 20 });

      const result = composer.compose();
      const parts = result.text.split('\n\n');

      expect(parts[0]).toBe('FIRST');
      expect(parts[1]).toBe('SECOND');
      expect(parts[2]).toBe('THIRD');
    });

    it('handles mixed types and priorities', () => {
      store.create({ type: 'operator', name: 'Op2', content: 'OP2', priority: 2 });
      store.create({ type: 'base', name: 'Base', content: 'BASE', priority: 0 });
      store.create({ type: 'operator', name: 'Op1', content: 'OP1', priority: 1 });

      const result = composer.compose();
      const parts = result.text.split('\n\n');

      expect(parts[0]).toBe('BASE');
      expect(parts[1]).toBe('OP1');
      expect(parts[2]).toBe('OP2');
    });
  });

  describe('disabled layers', () => {
    it('excludes disabled layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      store.toggle(runtime.id); // disable it

      const result = composer.compose();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('channel filtering', () => {
    it('includes matching channelType layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      store.create({ type: 'channel', name: 'API', content: 'API', channelType: 'api' });

      const result = composer.compose({ channelType: 'discord_text' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('DISCORD');
      expect(result.text).not.toContain('API');
      expect(result.layerCount).toBe(2);
    });

    it('excludes channel layers when no channelType in context', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });

      const result = composer.compose();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });

    it('excludes channel layers when channelType does not match', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });

      const result = composer.compose({ channelType: 'api' });

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('task filtering', () => {
    it('includes matching taskKind layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });
      store.create({ type: 'task', name: 'Reflection', content: 'REFLECTION', taskKind: 'reflection' });

      const result = composer.compose({ taskKind: 'heartbeat' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('HEARTBEAT');
      expect(result.text).not.toContain('REFLECTION');
      expect(result.layerCount).toBe(2);
    });

    it('excludes task layers when no taskKind in context', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });

      const result = composer.compose();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('compose result', () => {
    it('returns correct layerCount and layerIds', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const result = composer.compose();

      expect(result.layerCount).toBe(2);
      expect(result.layerIds).toEqual([base.id, runtime.id]);
    });

    it('produces deterministic hash for same layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const result1 = composer.compose();
      const result2 = composer.compose();

      expect(result1.hash).toBe(result2.hash);
      expect(result1.hash).toHaveLength(16);
    });

    it('produces different hash for different content', () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'content-A' });
      const hash1 = composer.compose().hash;

      store.update(layer.id, 'content-B', 'test');
      const hash2 = composer.compose().hash;

      expect(hash1).not.toBe(hash2);
    });

    it('returns split output with static prefix first and compose parity', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      const channel = store.create({
        type: 'channel',
        name: 'Discord',
        content: 'DISCORD',
        channelType: 'discord_text',
      });
      const task = store.create({
        type: 'task',
        name: 'Heartbeat',
        content: 'HEARTBEAT',
        taskKind: 'heartbeat',
      });

      const split = composer.composeSplit({ channelType: 'discord_text', taskKind: 'heartbeat' });

      expect(split.staticPrefix).toBe('BASE\n\nDISCORD');
      expect(split.dynamicSuffix).toBe('RUNTIME\n\nHEARTBEAT');
      expect(split.text).toBe('BASE\n\nDISCORD\n\nRUNTIME\n\nHEARTBEAT');
      expect(split.staticLayerIds).toEqual([base.id, channel.id]);
      expect(split.dynamicLayerIds).toEqual([runtime.id, task.id]);

      const composed = composer.compose({ channelType: 'discord_text', taskKind: 'heartbeat' });
      expect(composed.text).toBe(split.text);
      expect(composed.hash).toBe(split.hash);
    });

    it('keeps static hash stable when only dynamic layers change', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME-A' });

      const before = composer.composeSplit();
      store.update(runtime.id, 'RUNTIME-B', 'test');
      const after = composer.composeSplit();

      expect(before.staticHash).toBe(after.staticHash);
      expect(before.dynamicHash).not.toBe(after.dynamicHash);
      expect(before.staticLayerIds).toEqual([base.id]);
      expect(after.staticLayerIds).toEqual([base.id]);
    });

    it('invalidates static hash when a static layer changes', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE-A' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const before = composer.composeSplit();
      store.update(base.id, 'BASE-B', 'test');
      const after = composer.composeSplit();

      expect(before.staticHash).not.toBe(after.staticHash);
    });
  });

  describe('fallback to lastKnownGood', () => {
    it('returns lastKnownGood when all layers are disabled', () => {
      const base1 = store.create({ type: 'base', name: 'Base 1', content: 'BASE 1' });
      const base2 = store.create({ type: 'base', name: 'Base 2', content: 'BASE 2' });

      // Compose once to set lastKnownGood
      const good = composer.compose();
      expect(good.text).toContain('BASE 1');

      // Disable both via direct toggle (bypassing protection for test)
      store.toggle(base1.id);
      // base2 is still enabled, so toggling base1 is fine
      // Now base2 is the only one. To test fallback, we need to
      // simulate empty compose some other way.
      // Actually we can test with channel layers — add a channel layer,
      // compose with that channel to get lastKnownGood, then compose with
      // a different channel context that matches nothing.

      // Reset with fresh store
      const store2 = new PromptLayerStore(
        join(tmpDir, 'layers2.json'),
        join(tmpDir, 'history2.jsonl'),
      );
      const composer2 = new PromptComposer(store2);

      // Only a channel layer — no base, no always-on layers
      store2.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });

      // Compose with matching context to set lastKnownGood
      const goodResult = composer2.compose({ channelType: 'discord_text' });
      expect(goodResult.text).toBe('DISCORD');

      // Compose with non-matching context — no layers match
      const fallback = composer2.compose({ channelType: 'nonexistent' });
      expect(fallback.text).toBe('DISCORD'); // lastKnownGood
    });

    it('returns empty result when no layers and no lastKnownGood', () => {
      const result = composer.compose();

      expect(result.text).toBe('');
      expect(result.layerCount).toBe(0);
      expect(result.layerIds).toEqual([]);
    });
  });

  describe('combined channel and task context', () => {
    it('includes both channel and task layers when context matches', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });

      const result = composer.compose({ channelType: 'discord_text', taskKind: 'heartbeat' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('DISCORD');
      expect(result.text).toContain('HEARTBEAT');
      expect(result.layerCount).toBe(3);
    });
  });
});
