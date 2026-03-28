import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../../system/capabilities/gate.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import { IdentityCoolingOffManager } from '../../system/capabilities/safeguards.js';
import { PromptLayerStore } from './prompt-store.js';
import { CARD_BACKED_FOUNDATION_PROMPT_MESSAGE } from './canonical-foundation.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createIdentityDiffTool,
  createIdentityChangelogTool,
  createPromptLayerUpdateTool,
  createPromptLayerRollbackTool,
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

  function createCanonicalFoundationLayer() {
    return store.create({
      type: 'base',
      name: 'Character Foundation',
      identifier: 'main',
      role: 'system',
      promptOrder: 0,
      content: 'original foundation',
    });
  }

  function createNonFoundationBaseLayer(name = 'Character Foundation', identifier = 'alternate-base') {
    return store.create({
      type: 'base',
      name,
      identifier,
      role: 'system',
      promptOrder: 1,
      content: 'original',
    });
  }

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

    it('returns canonical error when store access throws', async () => {
      const brokenStore = {
        getAll: () => {
          throw new Error('list failed');
        },
      } as unknown as PromptLayerStore;

      const tool = createPromptLayerListTool(brokenStore);
      const result = await tool.execute('broken-list', {});

      expect(resultText(result)).toContain('prompt_layer_list failed');
      expect(resultText(result)).toContain('list failed');
      expect(result.details?.isError).toBe(true);
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
      expect(result.details?.isError).toBe(true);
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
      expect(missingLayer.details?.isError).toBe(true);

      const tooNew = await tool.execute('too-new', {
        layer_id: layer.id,
        version: 9,
      });
      expect(resultText(tooNew)).toContain('newer than current version');
      expect(tooNew.details?.isError).toBe(true);
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
      const layer = createNonFoundationBaseLayer('Base', 'base-nursery');
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

    it('rejects canonical Character Foundation updates in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = createCanonicalFoundationLayer();
        const tool = gateToolWithCapabilities(
          createPromptLayerUpdateTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`canonical-${tier}`, {
          layer_id: layer.id,
          content: `blocked-${tier}`,
        });

        expect(resultText(result)).toContain(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
        expect(result.details?.isError).toBe(true);
        expect(store.getById(layer.id)?.content).toBe('original foundation');
      }
    });

    it('allows non-foundation base layer updates in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = createNonFoundationBaseLayer('Character Foundation', `alternate-${tier}`);
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
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-stage');
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
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-cancel');
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

  describe('prompt_layer_rollback', () => {
    it('denies base rollbacks in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'rollback-nursery');
      store.update(layer.id, 'base-v2', 'agent', {}, 'base update');
      const tool = gateToolWithCapabilities(
        createPromptLayerRollbackTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('rollback-nursery', {
        layer_id: layer.id,
        version: 1,
      });

      expect(resultText(result)).toContain('Capability denied');
      expect(resultText(result)).toContain('identity.write.base');
      expect(store.getById(layer.id)?.content).toBe('base-v2');
    });

    it('rolls runtime layers back to historical content when authorized', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime-v1' });
      store.update(layer.id, 'runtime-v2', 'agent', {}, 'tweak');
      store.update(layer.id, 'runtime-v3', 'agent', {}, 'more tweak');
      const tool = gateToolWithCapabilities(
        createPromptLayerRollbackTool(store),
        () => accessForTier('nursery'),
      );

      const result = await tool.execute('rollback-runtime', {
        layer_id: layer.id,
        version: 1,
        reason: 'Revert runtime prompt to known good',
      });

      expect(resultText(result)).toContain('Rolled back layer');
      expect(store.getById(layer.id)?.content).toBe('runtime-v1');

      const history = store.getLayerHistory(layer.id);
      expect(history.at(-1)?.reason).toBe('Revert runtime prompt to known good');
    });

    it('stages base rollbacks with cooling-off in apprentice tier and commits after wait', async () => {
      let now = 5_000;
      const manager = new IdentityCoolingOffManager({
        now: () => now,
        defaultCooldownMs: 5_000,
        idFactory: () => 'rollback-stage-1',
      });
      const layer = createNonFoundationBaseLayer('Character Foundation', 'rollback-apprentice');
      store.update(layer.id, 'base-v2', 'agent', {}, 'base update');
      const tool = gateToolWithCapabilities(
        createPromptLayerRollbackTool(store, {
          identityCoolingOff: manager,
          getCapabilityTier: () => 'apprentice',
        }),
        () => accessForTier('apprentice'),
      );

      const staged = await tool.execute('rollback-stage', {
        layer_id: layer.id,
        version: 1,
      });
      expect(resultText(staged)).toContain('Staged base-layer rollback');
      expect(store.getById(layer.id)?.content).toBe('base-v2');

      const tooSoon = await tool.execute('rollback-commit-early', {
        action: 'commit',
        stage_id: 'rollback-stage-1',
      });
      expect(resultText(tooSoon)).toContain('cooling off');
      expect(store.getById(layer.id)?.content).toBe('base-v2');

      now = 10_100;
      const committed = await tool.execute('rollback-commit-ready', {
        action: 'commit',
        stage_id: 'rollback-stage-1',
      });
      expect(resultText(committed)).toContain('Committed staged rollback');
      expect(store.getById(layer.id)?.content).toBe('original');
    });
  });

  describe('prompt_layer_toggle', () => {
    it('denies base toggles in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'toggle-nursery');
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

    it('rejects canonical Character Foundation toggles in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        createNonFoundationBaseLayer('Fallback Base', `fallback-${tier}`);
        const layer = createCanonicalFoundationLayer();
        const tool = gateToolWithCapabilities(
          createPromptLayerToggleTool(store),
          () => accessForTier(tier),
        );

        const result = await tool.execute(`toggle-canonical-${tier}`, { layer_id: layer.id });

        expect(resultText(result)).toContain(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
        expect(result.details?.isError).toBe(true);
        expect(store.getById(layer.id)?.enabled).toBe(true);
      }
    });

    it('allows non-foundation base toggles in apprentice and autonomous tiers', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const baseA = createNonFoundationBaseLayer('Character Foundation', `main-clone-${tier}`);
        createNonFoundationBaseLayer(`Base-B-${tier}`, `support-${tier}`);
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
      expect(result.details?.isError).toBe(true);
    });
  });
});
