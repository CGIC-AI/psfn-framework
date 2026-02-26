import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../types.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../capabilities/gate.js';
import { resolveTierCapabilityTokens } from '../capabilities/tiers.js';
import { IdentityCoolingOffManager } from '../capabilities/safeguards.js';
import { PromptLayerStore } from './prompt-store.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createIdentityDiffTool,
  createIdentityChangelogTool,
  createPromptLayerUpdateTool,
  createPromptLayerToggleTool,
} from './prompt-tools.js';

/** Extract text from an AgentToolResult */
function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}

function accessForTier(
  tier: CapabilityTier,
  customTokens: CapabilityToken[] = [],
): CapabilityAccess {
  const granted = new Set(resolveTierCapabilityTokens(tier, customTokens));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

describe('Prompt Layer Tools', () => {
  let tmpDir: string;
  let store: PromptLayerStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-tools-'));
    store = new PromptLayerStore(
      join(tmpDir, 'layers.json'),
      join(tmpDir, 'history.jsonl'),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('prompt_layer_list', () => {
    it('returns message when no layers exist', async () => {
      const tool = createPromptLayerListTool(store);
      const result = await tool.execute('test', {});
      const text = resultText(result);

      expect(text).toBe('No prompt layers configured.');
    });

    it('lists all layers with their details', async () => {
      store.create({ type: 'base', name: 'Base', content: 'base content' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'runtime content', priority: 5 });
      store.create({ type: 'channel', name: 'Discord', content: 'discord', channelType: 'discord_text' });

      const tool = createPromptLayerListTool(store);
      const result = await tool.execute('test', {});
      const text = resultText(result);

      expect(text).toContain('[ON] base/Base');
      expect(text).toContain('[ON] runtime/Runtime');
      expect(text).toContain('priority=5');
      expect(text).toContain('channel=discord_text');
    });
  });

  describe('prompt_layer_get', () => {
    it('allows reading base/operator layers at all tiers', async () => {
      const baseLayer = store.create({ type: 'base', name: 'Test Base', content: 'You are helpful.' });
      const operatorLayer = store.create({ type: 'operator', name: 'Operator', content: 'Run safely.' });
      const tiers: CapabilityTier[] = ['nursery', 'apprentice', 'autonomous'];

      for (const tier of tiers) {
        const tool = gateToolWithCapabilities(
          createPromptLayerGetTool(store),
          () => accessForTier(tier),
        );

        const baseResult = await tool.execute(`base-${tier}`, { layer_id: baseLayer.id });
        const operatorResult = await tool.execute(`operator-${tier}`, { layer_id: operatorLayer.id });

        expect(resultText(baseResult)).toContain('Type: base');
        expect(resultText(baseResult)).toContain('You are helpful.');
        expect(resultText(operatorResult)).toContain('Type: operator');
        expect(resultText(operatorResult)).toContain('Run safely.');
      }

      const custom = gateToolWithCapabilities(
        createPromptLayerGetTool(store),
        () => accessForTier('custom', ['identity.read']),
      );
      const customResult = await custom.execute('custom-read', { layer_id: baseLayer.id });
      expect(resultText(customResult)).toContain('Type: base');
    });

    it('handles prefix match', async () => {
      const layer = store.create({ type: 'base', name: 'Test', content: 'content' });
      const prefix = layer.id.slice(0, 8);

      const tool = gateToolWithCapabilities(
        createPromptLayerGetTool(store),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('test', { layer_id: prefix });
      const text = resultText(result);

      expect(text).toContain('Name: Test');
    });

    it('returns not found for unknown id', async () => {
      const tool = gateToolWithCapabilities(
        createPromptLayerGetTool(store),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('test', { layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
    });
  });

  describe('identity_diff', () => {
    it('compares current layer content against a historical version', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a\nline-b' });
      store.update(layer.id, 'line-a\nline-c', 'agent', {}, 'First rewrite');
      store.update(layer.id, 'line-a\nline-d', 'agent', {}, 'Second rewrite');

      const tool = gateToolWithCapabilities(
        createIdentityDiffTool(store),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('diff', { layer_id: layer.id, version: 1 });
      const text = resultText(result);

      expect(text).toContain('Identity diff for runtime/Runtime');
      expect(text).toContain('Compared versions: v1 -> v3');
      expect(text).toContain('- line-b');
      expect(text).toContain('+ line-d');
    });

    it('returns validation errors for unknown layer or invalid versions', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a' });
      const tool = gateToolWithCapabilities(
        createIdentityDiffTool(store),
        () => accessForTier('nursery'),
      );

      const missingLayer = await tool.execute('missing', {
        layer_id: 'missing',
        version: 1,
      });
      expect(resultText(missingLayer)).toContain('Layer not found');

      const tooNew = await tool.execute('too-new', {
        layer_id: layer.id,
        version: 9,
      });
      expect(resultText(tooNew)).toContain('newer than current version');
    });
  });

  describe('identity_changelog', () => {
    it('returns who/what/when/why changelog entries', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a' });
      store.update(layer.id, 'line-b', 'agent', {}, 'Shift tone');
      store.update(layer.id, 'line-c', 'admin', {}, 'Operator calibration');

      const tool = gateToolWithCapabilities(
        createIdentityChangelogTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('changelog', { layer_id: layer.id, limit: 10 });
      const text = resultText(result);

      expect(text).toContain('Identity changelog for runtime/Runtime');
      expect(text).toContain('by agent');
      expect(text).toContain('why: Shift tone');
      expect(text).toContain('what: +1/-1 lines');
    });
  });

  describe('prompt_layer_update', () => {
    it('denies base layer updates in nursery tier', async () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'original' });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.base');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('allows base layer updates in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = store.create({ type: 'base', name: `Base-${tier}`, content: 'original' });
        const tool = gateToolWithCapabilities(
          createPromptLayerUpdateTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`test-${tier}`, {
          layer_id: layer.id,
          content: `modified-${tier}`,
        });
        const text = resultText(result);

        expect(text).toContain('Updated layer');
        expect(store.getById(layer.id)?.content).toBe(`modified-${tier}`);
        expect(store.getById(layer.id)?.updatedBy).toBe('agent');
      }
    });

    it('stages base updates with cooling-off in apprentice tier when safeguard is configured', async () => {
      let now = 1_000;
      const manager = new IdentityCoolingOffManager({
        now: () => now,
        defaultCooldownMs: 5_000,
        idFactory: () => 'stage-1',
      });
      const layer = store.create({ type: 'base', name: 'Base', content: 'original' });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store, {
          identityCoolingOff: manager,
          getCapabilityTier: () => 'apprentice',
        }),
        () => accessForTier('apprentice'),
      );

      const staged = await tool.execute('stage', {
        layer_id: layer.id,
        content: 'staged-change',
      });
      expect(resultText(staged)).toContain('Staged base-layer update');
      expect(store.getById(layer.id)?.content).toBe('original');

      const tooSoon = await tool.execute('commit-early', {
        action: 'commit',
        stage_id: 'stage-1',
      });
      expect(resultText(tooSoon)).toContain('cooling off');
      expect(store.getById(layer.id)?.content).toBe('original');

      now = 6_100;
      const committed = await tool.execute('commit-ready', {
        action: 'commit',
        stage_id: 'stage-1',
      });
      expect(resultText(committed)).toContain('Committed staged update');
      expect(store.getById(layer.id)?.content).toBe('staged-change');
    });

    it('allows cancelling staged base updates before commit', async () => {
      let sequence = 0;
      const manager = new IdentityCoolingOffManager({
        defaultCooldownMs: 5_000,
        idFactory: () => `stage-${++sequence}`,
      });
      const layer = store.create({ type: 'base', name: 'Base', content: 'original' });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store, {
          identityCoolingOff: manager,
          getCapabilityTier: () => 'apprentice',
        }),
        () => accessForTier('apprentice'),
      );

      await tool.execute('stage', {
        layer_id: layer.id,
        content: 'staged-change',
      });
      const cancelled = await tool.execute('cancel', {
        action: 'cancel',
        stage_id: 'stage-1',
      });
      expect(resultText(cancelled)).toContain('Cancelled staged base-layer update');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('denies operator layer updates in nursery tier', async () => {
      const layer = store.create({ type: 'operator', name: 'Operator', content: 'original' });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.operator');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('allows operator layer updates in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = store.create({ type: 'operator', name: `Operator-${tier}`, content: 'original' });
        const tool = gateToolWithCapabilities(
          createPromptLayerUpdateTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`test-${tier}`, {
          layer_id: layer.id,
          content: `operator-${tier}`,
        });
        const text = resultText(result);

        expect(text).toContain('Updated layer');
        expect(store.getById(layer.id)?.content).toBe(`operator-${tier}`);
      }
    });

    it('allows nursery updates for runtime/channel/task layers', async () => {
      const runtime = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime-original' });
      const channel = store.create({
        type: 'channel',
        name: 'Discord',
        content: 'channel-original',
        channelType: 'discord_text',
      });
      const task = store.create({
        type: 'task',
        name: 'Heartbeat',
        content: 'task-original',
        taskKind: 'heartbeat',
      });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store),
        () => accessForTier('nursery'),
      );

      const runtimeResult = await tool.execute('runtime', { layer_id: runtime.id, content: 'runtime-updated' });
      const channelResult = await tool.execute('channel', { layer_id: channel.id, content: 'channel-updated' });
      const taskResult = await tool.execute('task', { layer_id: task.id, content: 'task-updated' });

      expect(resultText(runtimeResult)).toContain('Updated layer');
      expect(resultText(channelResult)).toContain('Updated layer');
      expect(resultText(taskResult)).toContain('Updated layer');
      expect(store.getById(runtime.id)?.content).toBe('runtime-updated');
      expect(store.getById(channel.id)?.content).toBe('channel-updated');
      expect(store.getById(task.id)?.content).toBe('task-updated');
    });

    it('supports prefix match for layer id', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const prefix = layer.id.slice(0, 8);
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: prefix, content: 'updated' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
      expect(store.getById(layer.id)?.content).toBe('updated');
    });

    it('writes update reason into prompt history', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = gateToolWithCapabilities(
        createPromptLayerUpdateTool(store),
        () => accessForTier('nursery'),
      );

      await tool.execute('reasoned-update', {
        layer_id: layer.id,
        content: 'updated',
        reason: 'Need clearer guardrails',
      });

      const history = store.getLayerHistory(layer.id);
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('Need clearer guardrails');
    });
  });

  describe('prompt_layer_toggle', () => {
    it('denies base toggles in nursery tier', async () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'base' });
      const tool = gateToolWithCapabilities(
        createPromptLayerToggleTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.base');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('allows base toggles in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const baseA = store.create({ type: 'base', name: `Base-A-${tier}`, content: 'a' });
        store.create({ type: 'base', name: `Base-B-${tier}`, content: 'b' });
        const tool = gateToolWithCapabilities(
          createPromptLayerToggleTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`toggle-${tier}`, { layer_id: baseA.id });
        const text = resultText(result);

        expect(text).toContain('disabled');
        expect(store.getById(baseA.id)?.enabled).toBe(false);
      }
    });

    it('denies operator toggles in nursery tier', async () => {
      const layer = store.create({ type: 'operator', name: 'Operator', content: 'policy' });
      const tool = gateToolWithCapabilities(
        createPromptLayerToggleTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.operator');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('allows operator toggles in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = store.create({ type: 'operator', name: `Operator-${tier}`, content: 'policy' });
        const tool = gateToolWithCapabilities(
          createPromptLayerToggleTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`toggle-${tier}`, { layer_id: layer.id });
        const text = resultText(result);

        expect(text).toContain('disabled');
        expect(store.getById(layer.id)?.enabled).toBe(false);
      }
    });

    it('allows nursery runtime toggles', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      const tool = gateToolWithCapabilities(
        createPromptLayerToggleTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('disabled');
      expect(store.getById(layer.id)?.enabled).toBe(false);
    });

    it('allows re-enabling a disabled layer', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      store.toggle(layer.id); // disable
      expect(store.getById(layer.id)?.enabled).toBe(false);

      const tool = gateToolWithCapabilities(
        createPromptLayerToggleTool(store),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('enabled');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('returns not found for unknown layer', async () => {
      const tool = gateToolWithCapabilities(
        createPromptLayerToggleTool(store),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('test', { layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
    });
  });
});
