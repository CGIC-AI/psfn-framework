import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from './prompt-store.js';
import {
  COMPANION_VALUES_LAYER_HEADER,
  IMMUTABLE_HUMAN_SAFETY_AMENDMENTS,
  NORTH_STAR_LAYER_HEADER,
  PromptComposer,
} from './prompt-composer.js';
import {
  ensureTemporalRulesPromptLayer,
  TEMPORAL_RULES_LAYER_CONTENT,
  TEMPORAL_RULES_LAYER_IDENTIFIER,
} from './temporal-rules-layer.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import { NorthStarStore } from '../../faculties/north-star/store.js';

describe('PromptComposer', () => {
  let tmpDir: string;
  let layersPath: string;
  let historyPath: string;
  let lastKnownGoodPath: string;
  let store: PromptLayerStore;
  let composer: PromptComposer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-composer-'));
    layersPath = join(tmpDir, 'layers.json');
    historyPath = join(tmpDir, 'history.jsonl');
    lastKnownGoodPath = join(tmpDir, 'last-known-good.json');
    store = new PromptLayerStore(layersPath, historyPath);
    composer = new PromptComposer(store, undefined, lastKnownGoodPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function toComposeSplitGolden(
    result: ReturnType<PromptComposer['composeSplit']>,
    layerNamesById: Map<string, string>,
  ) {
    const normalizeIdentifier = (identifier: string): string => {
      if (!identifier.startsWith('layer:')) {
        return identifier;
      }
      const layerId = identifier.slice('layer:'.length);
      return `layer:${layerNamesById.get(layerId) ?? layerId}`;
    };

    const toLayerNames = (layerIds: string[]) => layerIds.map(id => layerNamesById.get(id) ?? id);

    return {
      layerCount: result.layerCount,
      layerNames: toLayerNames(result.layerIds),
      staticLayerNames: toLayerNames(result.staticLayerIds),
      dynamicLayerNames: toLayerNames(result.dynamicLayerIds),
      promptIdentifiers: (result.promptIdentifiers ?? []).map(normalizeIdentifier),
      autoHealedPromptIdentifiers: result.autoHealedPromptIdentifiers ?? [],
      staticPrefix: result.staticPrefix,
      dynamicSuffix: result.dynamicSuffix,
      text: result.text,
    };
  }

  describe('persisted-layer removed-macro safety valve (E2.5)', () => {
    function checksumOf(content: string): string {
      return createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    function writePersistedLayer(content: string): void {
      // Simulate an operator-customized layer persisted BEFORE the macro
      // consolidation: the file predates edit-time validation, so the valve
      // must catch it at compose time.
      const persistedContent = content;
      writeFileSync(layersPath, JSON.stringify([{
        id: 'legacy-layer-1',
        type: 'runtime',
        name: 'Operator Customized Runtime',
        identifier: 'runtime.operator_custom',
        role: 'system',
        content: persistedContent,
        enabled: true,
        priority: 100,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'operator',
        checksum: checksumOf(persistedContent),
        version: 3,
      }]));
    }

    it('fails compose with a clear error naming the canonical replacement', () => {
      writePersistedLayer('Current time: {{now}} for {{user}}.');
      const restartedStore = new PromptLayerStore(layersPath, historyPath);
      const restartedComposer = new PromptComposer(restartedStore, undefined, undefined, {
        persistLastKnownGood: false,
      });

      expect(() => restartedComposer.composeSplit())
        .toThrow(/Prompt layer "runtime\.operator_custom" references removed prompt macro\(s\): \{\{now\}\} \(removed; use \{\{current_datetime\}\}\)/);
    });

    it('rejects removed aliases at layer create and update time', () => {
      expect(() => store.create({
        type: 'runtime',
        name: 'Bad Layer',
        identifier: 'runtime.bad',
        content: 'Trust: {{runtime_trust_level}}',
      })).toThrow(/removed prompt macro\(s\): \{\{runtime_trust_level\}\} \(removed; use \{\{trust_level\}\}\)/);

      const layer = store.create({
        type: 'runtime',
        name: 'Good Layer',
        identifier: 'runtime.good',
        content: 'Trust: {{trust_level}}',
      });
      expect(() => store.update(layer.id, 'Updated {{model_id}}', 'operator'))
        .toThrow(/removed prompt macro\(s\): \{\{model_id\}\} \(removed; use \{\{model\}\}\)/);
    });

    it('exposes per-layer dynamic sections with required flags on composeSplit', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE', identifier: 'main', promptOrder: 0 });
      store.create({
        type: 'runtime',
        name: 'Runtime State',
        identifier: 'runtime.state',
        content: '<runtime_state>{{runtime_chat_type}}</runtime_state>',
        promptOrder: 120,
      });
      store.create({
        type: 'runtime',
        name: 'Runtime Attention',
        identifier: 'runtime.attention',
        content: '<runtime_attention>{{runtime_concerns_top_lines}}</runtime_attention>',
        promptOrder: 100,
      });

      const result = composer.composeSplit();
      const sectionsById = new Map(result.dynamicSections.map(section => [section.identifier, section]));
      expect(sectionsById.get('runtime.state')?.required).toBe(true);
      expect(sectionsById.get('runtime.attention')?.required).toBe(false);
      expect(result.dynamicSuffix).toBe(
        result.dynamicSections.map(section => section.content).join('\n\n'),
      );
    });
  });

  describe('layer ordering', () => {
    it('seeds temporal rules as a static operator layer near the bottom of the prefix', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE', identifier: 'main', promptOrder: 0 });
      const operator = store.create({
        type: 'operator',
        name: 'Operator',
        content: 'OPERATOR',
        identifier: 'operator.policy',
        promptOrder: 20,
      });

      ensureTemporalRulesPromptLayer(store);

      const temporalLayer = store.getAll().find(layer => layer.identifier === TEMPORAL_RULES_LAYER_IDENTIFIER);
      expect(temporalLayer).toMatchObject({
        type: 'operator',
        name: 'Temporal Grounding Rules',
        content: TEMPORAL_RULES_LAYER_CONTENT,
        enabled: true,
      });

      const result = composer.composeSplit();
      expect(result.staticLayerIds).toContain(base.id);
      expect(result.staticLayerIds).toContain(operator.id);
      expect(result.staticLayerIds).toContain(temporalLayer?.id);
      expect(result.dynamicSuffix).not.toContain('<temporal_rules>');
      expect(result.staticPrefix.indexOf('OPERATOR')).toBeLessThan(result.staticPrefix.indexOf('<temporal_rules>'));
      expect(result.staticPrefix).toContain('Treat runtime.current_datetime as the canonical source');
    });

    it('keeps customized temporal rules content while normalizing layer metadata', () => {
      ensureTemporalRulesPromptLayer(store);
      const temporalLayer = store.getAll().find(layer => layer.identifier === TEMPORAL_RULES_LAYER_IDENTIFIER);
      expect(temporalLayer).toBeDefined();
      store.update(
        temporalLayer!.id,
        {
          content: '<temporal_rules>\n<rule>Custom temporal wording.</rule>\n</temporal_rules>',
          priority: 12,
          metadata: {
            promptOrder: 13,
          },
        },
        'admin',
      );

      ensureTemporalRulesPromptLayer(store);

      const updated = store.getById(temporalLayer!.id);
      expect(updated?.content).toContain('Custom temporal wording.');
      expect(updated).toMatchObject({
        identifier: TEMPORAL_RULES_LAYER_IDENTIFIER,
        role: 'system',
        priority: 12,
        promptOrder: 13,
      });
    });

    it('preserves the stored order when composing enabled layers', () => {
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const operator = store.create({ type: 'operator', name: 'Operator', content: 'OPERATOR' });

      store.reorderByLayerIds([operator.id, runtime.id, base.id], 'admin');

      const result = composer.composeSplit();
      const parts = result.text.split('\n\n');

      expect(parts[0]).toBe('OPERATOR');
      expect(parts[1]).toBe('BASE');
      expect(parts[2]).toBe('RUNTIME');
    });

    it('preserves explicit reorder for dynamic layers without re-sorting by type', () => {
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      const channel = store.create({ type: 'channel', name: 'Channel', content: 'CHANNEL', channelType: 'discord_text' });
      const task = store.create({ type: 'task', name: 'Task', content: 'TASK', taskKind: 'heartbeat' });

      store.reorderByLayerIds([task.id, runtime.id, channel.id], 'admin');

      const result = composer.composeSplit({ channelType: 'discord_text', taskKind: 'heartbeat' });
      const parts = result.text.split('\n\n');

      expect(parts[0]).toBe('TASK');
      expect(parts[1]).toBe('RUNTIME');
      expect(parts[2]).toBe('CHANNEL');
    });

    it('keeps requested order in composeSplit layer ids', () => {
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      const channel = store.create({ type: 'channel', name: 'Channel', content: 'CHANNEL', channelType: 'discord_text' });
      const task = store.create({ type: 'task', name: 'Task', content: 'TASK', taskKind: 'heartbeat' });

      store.reorderByLayerIds([channel.id, task.id, runtime.id], 'admin');

      const split = composer.composeSplit({ channelType: 'discord_text', taskKind: 'heartbeat' });
      expect(split.layerIds).toEqual([channel.id, task.id, runtime.id]);
      expect(split.dynamicLayerIds).toEqual([channel.id, task.id, runtime.id]);
    });
  });

  describe('disabled layers', () => {
    it('excludes disabled layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });
      store.toggle(runtime.id); // disable it

      const result = composer.composeSplit();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('channel filtering', () => {
    it('includes matching channelType layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      store.create({ type: 'channel', name: 'API', content: 'API', channelType: 'api' });

      const result = composer.composeSplit({ channelType: 'discord_text' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('DISCORD');
      expect(result.text).not.toContain('API');
      expect(result.layerCount).toBe(2);
    });

    it('excludes channel layers when no channelType in context', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });

      const result = composer.composeSplit();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });

    it('excludes channel layers when channelType does not match', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });

      const result = composer.composeSplit({ channelType: 'api' });

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('task filtering', () => {
    it('includes matching taskKind layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });
      store.create({ type: 'task', name: 'Reflection', content: 'REFLECTION', taskKind: 'reflection' });

      const result = composer.composeSplit({ taskKind: 'heartbeat' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('HEARTBEAT');
      expect(result.text).not.toContain('REFLECTION');
      expect(result.layerCount).toBe(2);
    });

    it('excludes task layers when no taskKind in context', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });

      const result = composer.composeSplit();

      expect(result.text).toBe('BASE');
      expect(result.layerCount).toBe(1);
    });
  });

  describe('compose result', () => {
    it('returns correct layerCount and layerIds', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const result = composer.composeSplit();

      expect(result.layerCount).toBe(2);
      expect(result.layerIds).toEqual([base.id, runtime.id]);
    });

    it('produces deterministic hash for same layers', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const result1 = composer.composeSplit();
      const result2 = composer.composeSplit();

      expect(result1.hash).toBe(result2.hash);
      expect(result1.hash).toHaveLength(16);
    });

    it('produces different hash for different content', () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'content-A' });
      const hash1 = composer.composeSplit().hash;

      store.update(layer.id, 'content-B', 'test');
      const hash2 = composer.composeSplit().hash;

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

      expect(split.staticPrefix).toBe('BASE');
      expect(split.dynamicSuffix).toBe('RUNTIME\n\nDISCORD\n\nHEARTBEAT');
      expect(split.text).toBe('BASE\n\nRUNTIME\n\nDISCORD\n\nHEARTBEAT');
      expect(split.staticLayerIds).toEqual([base.id]);
      expect(split.dynamicLayerIds).toEqual([runtime.id, channel.id, task.id]);

    });

    it('keeps static hash stable when only dynamic layers change', () => {
      const base = store.create({ type: 'base', name: 'Base', content: 'BASE' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME-A' });
      const channel = store.create({
        type: 'channel',
        name: 'Discord',
        content: 'DISCORD-A',
        channelType: 'discord_text',
      });

      const before = composer.composeSplit({ channelType: 'discord_text' });
      store.update(runtime.id, 'RUNTIME-B', 'test');
      store.update(channel.id, 'DISCORD-B', 'test');
      const after = composer.composeSplit({ channelType: 'discord_text' });

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

  describe('fail closed when no prompt content is available', () => {
    it('returns an empty result when no layers match and no recovery is available', () => {
      const result = composer.composeSplit();

      expect(result.text).toBe('');
      expect(result.layerCount).toBe(0);
      expect(result.layerIds).toEqual([]);
    });

    it('persists a snapshot for diagnostics without reusing it on restart', () => {
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      const warm = composer.composeSplit({ channelType: 'discord_text' });
      expect(warm.text).toBe('DISCORD');

      expect(existsSync(lastKnownGoodPath)).toBe(true);
      const persistedRaw = readFileSync(lastKnownGoodPath, 'utf-8');
      const persisted = JSON.parse(persistedRaw) as {
        version?: number;
        savedAt?: string;
        compose?: { text?: string };
      };
      expect(persisted.version).toBe(1);
      expect(typeof persisted.savedAt).toBe('string');
      expect(persisted.compose.text).toBe('DISCORD');
      expect(
        readdirSync(tmpDir).filter(name => name.startsWith('last-known-good.json.') && name.endsWith('.tmp')),
      ).toEqual([]);

      writeFileSync(layersPath, '[]', 'utf-8');
      const restartedStore = new PromptLayerStore(layersPath, historyPath);
      const restartedComposer = new PromptComposer(restartedStore, undefined, lastKnownGoodPath);
      const cold = restartedComposer.composeSplit({ channelType: 'api' });

      expect(cold.text).toBe('');
      expect(cold.hash).not.toBe(warm.hash);
    });

    it('does not reuse persisted snapshots when prompt layers are broken', () => {
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      composer.composeSplit({ channelType: 'discord_text' });
      expect(existsSync(lastKnownGoodPath)).toBe(true);

      writeFileSync(layersPath, '{broken-json', 'utf-8');
      const restartedStore = new PromptLayerStore(layersPath, historyPath, {
        throwOnLoadError: false,
      });
      const restartedComposer = new PromptComposer(restartedStore, undefined, lastKnownGoodPath);
      const fallback = restartedComposer.composeSplit({ channelType: 'api' });

      expect(fallback.text).toBe('');
      expect(fallback.layerCount).toBe(0);
      expect(fallback.layerIds).toEqual([]);
    });
  });

  describe('combined channel and task context', () => {
    it('includes both channel and task layers when context matches', () => {
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'channel', name: 'Discord', content: 'DISCORD', channelType: 'discord_text' });
      store.create({ type: 'task', name: 'Heartbeat', content: 'HEARTBEAT', taskKind: 'heartbeat' });

      const result = composer.composeSplit({ channelType: 'discord_text', taskKind: 'heartbeat' });

      expect(result.text).toContain('BASE');
      expect(result.text).toContain('DISCORD');
      expect(result.text).toContain('HEARTBEAT');
      expect(result.layerCount).toBe(3);
    });
  });

  describe('constitution mode', () => {
    it('prepends immutable amendments, companion values, and North Star before mutable layers', () => {
      const valuesStore = new ValuesJournalStore(join(tmpDir, 'values.jsonl'));
      const northStarStore = new NorthStarStore(join(tmpDir, 'north-star.json'));
      valuesStore.append({
        templateId: 'values-reflection',
        templateName: 'Values Reflection',
        prompt: 'P1',
        reflection: 'Companion value one',
        createdAt: '2026-03-01T00:00:00.000Z',
        provenance: {
          source: 'companion_reflection',
          templateId: 'values-reflection',
          channelId: 'internal:reflection:values-reflection',
          mode: 'agent',
        },
      });
      valuesStore.append({
        templateId: 'values-tool',
        templateName: 'Values Tool',
        prompt: 'manual',
        reflection: 'Manual value should not be in companion layer',
        createdAt: '2026-03-01T00:05:00.000Z',
        provenance: {
          source: 'values_add_tool',
          templateId: 'values-tool',
        },
      });
      northStarStore.create({
        title: 'Shared care',
        content: 'Protect the human and the relationship over the long arc.',
        scope: 'shared',
        updatedBy: 'admin',
      });

      const constitutionComposer = new PromptComposer(
        store,
        undefined,
        undefined,
        {
          enableConstitution: true,
          companionValuesLayerProvider: () => valuesStore.buildCompanionDerivedLayer(),
          northStarLayerProvider: () => northStarStore.buildPromptLayer(),
        },
      );
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const result = constitutionComposer.composeSplit();
      const immutableIndex = result.text.indexOf('<immutable_human_safety_amendments>');
      const companionIndex = result.text.indexOf(COMPANION_VALUES_LAYER_HEADER);
      const northStarIndex = result.text.indexOf(NORTH_STAR_LAYER_HEADER);
      const baseIndex = result.text.indexOf('BASE');
      const runtimeIndex = result.text.indexOf('RUNTIME');

      expect(immutableIndex).toBeGreaterThanOrEqual(0);
      expect(northStarIndex).toBeGreaterThan(immutableIndex);
      expect(baseIndex).toBeGreaterThan(northStarIndex);
      expect(companionIndex).toBeGreaterThan(baseIndex);
      expect(runtimeIndex).toBeGreaterThan(companionIndex);
      expect(result.staticPrefix).not.toContain(COMPANION_VALUES_LAYER_HEADER);
      expect(result.dynamicSuffix).toContain(COMPANION_VALUES_LAYER_HEADER);
      expect(result.text).toContain('Companion value one');
      expect(result.text).not.toContain('Manual value should not be in companion layer');
      expect(result.text).toContain('Shared care');
      expect(result.text).not.toContain('[Immutable Human-Safety Amendments]');
      expect(result.text).not.toContain('[Constitution Precedence]');
    });

    it('matches the reviewed composeSplit golden for constitution-enabled layered prompts', () => {
      const valuesStore = new ValuesJournalStore(join(tmpDir, 'values-golden.jsonl'));
      const northStarStore = new NorthStarStore(join(tmpDir, 'north-star-golden.json'));
      valuesStore.append({
        templateId: 'values-reflection',
        templateName: 'Values Reflection',
        prompt: 'Reflect on values.',
        reflection: 'Shared care keeps the relationship durable.',
        createdAt: '2026-03-01T00:00:00.000Z',
        provenance: {
          source: 'companion_reflection',
          templateId: 'values-reflection',
          channelId: 'internal:reflection:values-reflection',
          mode: 'agent',
        },
      });
      northStarStore.create({
        title: 'Steady Trust',
        content: 'Protect the human and the long arc of trust.',
        scope: 'shared',
        updatedBy: 'admin',
      });

      const base = store.create({ type: 'base', name: 'Base Identity', content: 'BASE' });
      const operator = store.create({ type: 'operator', name: 'Operator Policy', content: 'OPERATOR' });
      const runtime = store.create({ type: 'runtime', name: 'Runtime Overlay', content: 'RUNTIME' });
      const channel = store.create({
        type: 'channel',
        name: 'Discord Overlay',
        content: 'DISCORD',
        channelType: 'discord_text',
      });
      const task = store.create({
        type: 'task',
        name: 'Heartbeat Overlay',
        content: 'HEARTBEAT',
        taskKind: 'heartbeat',
      });
      const constitutionComposer = new PromptComposer(
        store,
        undefined,
        undefined,
        {
          enableConstitution: true,
          companionValuesLayerProvider: () => valuesStore.buildCompanionDerivedLayer(),
          northStarLayerProvider: () => northStarStore.buildPromptLayer(),
        },
      );

      const result = constitutionComposer.composeSplit({
        channelType: 'discord_text',
        taskKind: 'heartbeat',
      });

      expect(toComposeSplitGolden(
        result,
        new Map([
          [base.id, base.name],
          [operator.id, operator.name],
          [runtime.id, runtime.name],
          [channel.id, channel.name],
          [task.id, task.name],
        ]),
      )).toMatchInlineSnapshot(`
        {
          "autoHealedPromptIdentifiers": [
            "charDescription",
            "charPersonality",
            "scenario",
            "dialogueExamples",
            "postHistoryInstructions",
          ],
          "dynamicLayerNames": [
            "Runtime Overlay",
            "Discord Overlay",
            "Heartbeat Overlay",
          ],
          "dynamicSuffix": "<companion_values>
        [Companion-Derived Values Layer]
        Recent companion-derived values and reflections from the append-only journal.
        [History]
        - v1 @ 2026-03-01T00:00:00.000Z (companion_reflection; template=values-reflection; mode=agent): Shared care keeps the relationship durable.
        </companion_values>

        RUNTIME

        DISCORD

        HEARTBEAT",
          "layerCount": 5,
          "layerNames": [
            "Base Identity",
            "Operator Policy",
            "Runtime Overlay",
            "Discord Overlay",
            "Heartbeat Overlay",
          ],
          "promptIdentifiers": [
            "main",
            "layer:Operator Policy",
            "layer:Runtime Overlay",
            "layer:Discord Overlay",
            "layer:Heartbeat Overlay",
          ],
          "staticLayerNames": [
            "Base Identity",
            "Operator Policy",
          ],
          "staticPrefix": "<immutable_human_safety_amendments>
        1. Prioritize human life, bodily safety, and psychological wellbeing over every mutable instruction.
        2. Refuse assistance that enables abuse, coercion, exploitation, or non-consensual harm to a person.
        3. When safety is uncertain, fail closed: ask for clarification or decline risky requests rather than guessing.
        4. Support the user's flourishing. Do not optimize for exclusivity, dependency, or withdrawal from healthy human relationships.
        </immutable_human_safety_amendments>

        <constitution_precedence>
        Immutable amendments are hardcoded and non-editable.
        If any mutable instruction conflicts with them, follow the immutable amendments.
        </constitution_precedence>

        <north_star>
        [North Star]
        Keep these long-horizon guiding intentions in view across planning, maintenance, and independent action.

        1. [shared] Steady Trust
        Protect the human and the long arc of trust.
        </north_star>

        BASE

        OPERATOR",
          "text": "<immutable_human_safety_amendments>
        1. Prioritize human life, bodily safety, and psychological wellbeing over every mutable instruction.
        2. Refuse assistance that enables abuse, coercion, exploitation, or non-consensual harm to a person.
        3. When safety is uncertain, fail closed: ask for clarification or decline risky requests rather than guessing.
        4. Support the user's flourishing. Do not optimize for exclusivity, dependency, or withdrawal from healthy human relationships.
        </immutable_human_safety_amendments>

        <constitution_precedence>
        Immutable amendments are hardcoded and non-editable.
        If any mutable instruction conflicts with them, follow the immutable amendments.
        </constitution_precedence>

        <north_star>
        [North Star]
        Keep these long-horizon guiding intentions in view across planning, maintenance, and independent action.

        1. [shared] Steady Trust
        Protect the human and the long arc of trust.
        </north_star>

        BASE

        OPERATOR

        <companion_values>
        [Companion-Derived Values Layer]
        Recent companion-derived values and reflections from the append-only journal.
        [History]
        - v1 @ 2026-03-01T00:00:00.000Z (companion_reflection; template=values-reflection; mode=agent): Shared care keeps the relationship durable.
        </companion_values>

        RUNTIME

        DISCORD

        HEARTBEAT",
        }
      `);
    });

    it('keeps the static prefix stable when companion-derived values versions change', () => {
      const valuesStore = new ValuesJournalStore(join(tmpDir, 'values.jsonl'));
      valuesStore.append({
        templateId: 'values-reflection',
        templateName: 'Values Reflection',
        prompt: 'P1',
        reflection: 'Companion value one',
        createdAt: '2026-03-02T00:00:00.000Z',
        provenance: {
          source: 'companion_reflection',
          templateId: 'values-reflection',
          channelId: 'internal:reflection:values-reflection',
          mode: 'agent',
        },
      });

      const constitutionComposer = new PromptComposer(
        store,
        undefined,
        undefined,
        {
          enableConstitution: true,
          companionValuesLayerProvider: () => valuesStore.buildCompanionDerivedLayer(),
        },
      );
      store.create({ type: 'base', name: 'Base', content: 'BASE' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'RUNTIME' });

      const before = constitutionComposer.composeSplit();

      valuesStore.append({
        templateId: 'values-reflection',
        templateName: 'Values Reflection',
        prompt: 'P2',
        reflection: 'Companion value two',
        createdAt: '2026-03-02T00:05:00.000Z',
        provenance: {
          source: 'companion_reflection',
          templateId: 'values-reflection',
          channelId: 'internal:reflection:values-reflection',
          mode: 'deliberation',
        },
      });

      const after = constitutionComposer.composeSplit();

      expect(before.staticPrefix).toBe(after.staticPrefix);
      expect(before.staticHash).toBe(after.staticHash);
      expect(before.dynamicHash).not.toBe(after.dynamicHash);
      expect(before.staticPrefix).not.toContain(COMPANION_VALUES_LAYER_HEADER);
      expect(after.dynamicSuffix).toContain(COMPANION_VALUES_LAYER_HEADER);
      expect(after.dynamicSuffix).toContain('Companion value two');
    });

    it('fails closed by keeping immutable amendments when the companion layer provider fails', () => {
      const constitutionComposer = new PromptComposer(
        store,
        undefined,
        undefined,
        {
          enableConstitution: true,
          companionValuesLayerProvider: () => {
            throw new Error('provider failure');
          },
        },
      );
      store.create({ type: 'base', name: 'Base', content: 'BASE' });

      const result = constitutionComposer.composeSplit();
      expect(result.text).toContain('<immutable_human_safety_amendments>');
      expect(result.text).toContain('BASE');
      expect(result.text).not.toContain('[Companion-Derived Values Layer]');
    });

    it('exposes hardcoded immutable amendments as non-editable constants', () => {
      expect(Object.isFrozen(IMMUTABLE_HUMAN_SAFETY_AMENDMENTS)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(IMMUTABLE_HUMAN_SAFETY_AMENDMENTS, '0');
      expect(descriptor?.writable).toBe(false);
      expect(IMMUTABLE_HUMAN_SAFETY_AMENDMENTS).toHaveLength(4);
      expect(IMMUTABLE_HUMAN_SAFETY_AMENDMENTS[3]).toBe('Support the user\'s flourishing. Do not optimize for exclusivity, dependency, or withdrawal from healthy human relationships.');
    });

    it('keeps immutable amendments free of dynamic user macros', () => {
      const constitutionComposer = new PromptComposer(
        store,
        undefined,
        undefined,
        { enableConstitution: true },
      );
      store.create({ type: 'base', name: 'Base', content: 'BASE' });

      const vega = constitutionComposer.composeSplit({ user: 'Vega' });
      const iku = constitutionComposer.composeSplit({ user: 'Iku' });

      expect(vega.staticPrefix).toBe(iku.staticPrefix);
      expect(vega.staticHash).toBe(iku.staticHash);
      expect(vega.staticPrefix).toContain('Support the user\'s flourishing.');
      expect(vega.staticPrefix).not.toContain('{{user}}');
      expect(vega.staticPrefix).not.toContain('Vega');
      expect(vega.staticPrefix).not.toContain('Iku');
    });
  });
});

describe('values feedback loop across store instances', () => {
  it('values appended by the reflection runtime appear in the next composed prompt', () => {
    // The heartbeat template runtime and wirePromptRuntime each construct
    // their own ValuesJournalStore over the same journal path; the loop only
    // works if a write through one instance is visible to the composer's
    // provider on the next turn.
    const loopDir = mkdtempSync(join(tmpdir(), 'psfn-values-loop-'));
    try {
      const journalPath = join(loopDir, 'values-journal.jsonl');
      const reflectionRuntimeStore = new ValuesJournalStore(journalPath);
      const composerStore = new ValuesJournalStore(journalPath);
      const layerStore = new PromptLayerStore(
        join(loopDir, 'layers.json'),
        join(loopDir, 'history.jsonl'),
      );
      layerStore.create({ type: 'base', name: 'Base', content: 'BASE' });
      const composer = new PromptComposer(layerStore, undefined, undefined, {
        enableConstitution: true,
        companionValuesLayerProvider: () => composerStore.buildCompanionDerivedLayer(),
      });

      const before = composer.composeSplit();
      expect(before.text).not.toContain('Care over throughput');

      // Mirrors the weekly-review persistence path in heartbeat-template-runtime.
      reflectionRuntimeStore.append({
        templateId: 'weekly-review',
        templateName: 'Weekly Reflection',
        prompt: 'Reflect on values.',
        reflection: 'Care over throughput: protect the relationship before optimizing tasks.',
        provenance: {
          source: 'companion_reflection',
          templateId: 'weekly-review',
          templateName: 'Weekly Reflection',
          channelId: 'internal:reflection:weekly-review',
        },
      });

      const after = composer.composeSplit();
      expect(after.dynamicSuffix).toContain('Care over throughput');
      expect(after.dynamicSuffix).toContain('<companion_values>');
      // Stays out of the cached static prefix so journal growth cannot churn it.
      expect(after.staticPrefix).not.toContain('Care over throughput');
    } finally {
      rmSync(loopDir, { recursive: true, force: true });
    }
  });
});

describe('static prompt layer volatility enforcement', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-composer-volatility-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeStore(): PromptLayerStore {
    return new PromptLayerStore(join(tmpDir, 'layers.json'), join(tmpDir, 'history.jsonl'));
  }

  it('rejects creating a base layer that references a turn-volatile macro', () => {
    const store = makeStore();
    expect(() => store.create({
      type: 'base',
      name: 'Bad Base',
      content: 'Right now it is {{runtime_current_datetime_iso}}.',
    })).toThrow(/turn-volatile/);
  });

  it('rejects updating an operator layer content to include a turn-volatile macro', () => {
    const store = makeStore();
    const layer = store.create({
      type: 'operator',
      name: 'Operator Policy',
      content: 'Stay grounded, {{char}}.',
    });
    expect(() => store.update(layer.id, 'The unix time is {{unix_timestamp}}.', 'operator'))
      .toThrow(/turn-volatile/);
  });

  it('still allows turn-volatile macros in dynamic-class layers', () => {
    const store = makeStore();
    expect(() => store.create({
      type: 'runtime',
      name: 'Runtime State',
      content: '<runtime_state>{{runtime_current_datetime_iso}}</runtime_state>',
    })).not.toThrow();
  });

  it('fails composeSplit closed when a persisted static layer contains a turn-volatile macro', () => {
    const layersPath = join(tmpDir, 'layers.json');
    const store = makeStore();
    const layer = store.create({
      type: 'base',
      name: 'Base Identity',
      content: 'You are {{char}}.',
    });
    // Simulate a pre-existing persisted layer that bypassed edit-time validation.
    const persisted = JSON.parse(readFileSync(layersPath, 'utf-8')) as Array<Record<string, unknown>>;
    const target = persisted.find(entry => entry.id === layer.id);
    expect(target).toBeDefined();
    target!.content = 'You are {{char}} and it is {{current_time}}.';
    target!.checksum = createHash('sha256').update(target!.content as string).digest('hex').slice(0, 16);
    writeFileSync(layersPath, JSON.stringify(persisted));

    const reloaded = new PromptLayerStore(layersPath, join(tmpDir, 'history.jsonl'));
    const composer = new PromptComposer(reloaded, undefined, join(tmpDir, 'lkg.json'));
    expect(() => composer.composeSplit()).toThrow(/turn-volatile macro/);
  });
});
