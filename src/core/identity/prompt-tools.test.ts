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
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { PromptLayerStore } from './prompt-store.js';
import { CARD_BACKED_FOUNDATION_PROMPT_MESSAGE } from './canonical-foundation.js';
import { createIdentityTool, type IdentityToolOptions } from './prompt-tools.js';

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

  function identityTool(
    tier: CapabilityTier,
    options: IdentityToolOptions = {},
    customTokens: CapabilityToken[] = [],
  ) {
    return gateToolWithCapabilities(
      createIdentityTool(store, options),
      () => accessForTier(tier, customTokens),
    );
  }

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

  describe('identity', () => {
    it('defaults empty-argument calls to list_layers', async () => {
      const tool = identityTool('nursery');
      const result = await tool.execute('identity-default-list', {});

      expect(resultText(result)).toBe('No prompt layers configured.');
    });

    it('fails closed on ambiguous cross-surface parameters', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = identityTool('nursery');

      const result = await tool.execute('identity-ambiguous', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'updated',
        personality: 'Conflicting persona field',
      });

      expect(resultText(result)).toContain('does not accept persona mutation fields');
      expect(result.details?.isError).toBe(true);
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('returns structured toggle proof from the unified identity tool', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      const tool = identityTool('nursery');

      const first = await tool.execute('identity-toggle-first', {
        action: 'toggle_layer',
        layer_id: layer.id,
      });
      const second = await tool.execute('identity-toggle-second', {
        action: 'toggle_layer',
        layer_id: layer.id,
      });
      const firstPayload = JSON.parse(resultText(first)) as {
        action: string;
        layerId: string;
        previousEnabled: boolean;
        enabled: boolean;
        state: string;
      };
      const secondPayload = JSON.parse(resultText(second)) as {
        layerId: string;
        previousEnabled: boolean;
        enabled: boolean;
        state: string;
      };

      expect(firstPayload).toMatchObject({
        action: 'toggle_layer',
        layerId: layer.id,
        previousEnabled: true,
        enabled: false,
        state: 'disabled',
      });
      expect(secondPayload).toMatchObject({
        layerId: layer.id,
        previousEnabled: false,
        enabled: true,
        state: 'enabled',
      });
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('queues protected prompt-layer updates from the unified identity tool', async () => {
      const queue = new ConfirmationQueue({ idFactory: () => 'identity-layer-1' });
      const layer = createNonFoundationBaseLayer('Self Addendum', 'self-addendum');
      const tool = identityTool('autonomous', {
        confirmationQueue: queue,
        getCapabilityTier: () => 'autonomous',
      });

      const result = await tool.execute('identity-protected-update', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'proposed self addendum',
        reason: 'Improve self-description',
      });

      expect(resultText(result)).toContain('Prompt-layer update queued for confirmation');
      expect(queue.listPending()).toHaveLength(1);
      expect(store.getById(layer.id)?.content).toBe('original');

      const resolved = await queue.resolve({ id: 'identity-layer-1', decision: 'approve' });
      expect(resolved.status).toBe('approved');
      expect(store.getById(layer.id)?.content).toBe('proposed self addendum');
      expect(store.getById(layer.id)?.updatedBy).toBe('admin:confirmation');
    });
  });

  describe('identity action=list_layers', () => {
    it('returns message when no layers exist', async () => {
      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'list_layers' });
      const text = resultText(result);

      expect(text).toBe('No prompt layers configured.');
    });

    it('lists all layers with their details', async () => {
      store.create({ type: 'base', name: 'Base', content: 'base content' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'runtime content', priority: 5 });
      store.create({ type: 'channel', name: 'Discord', content: 'discord', channelType: 'discord_text' });

      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'list_layers' });
      const text = resultText(result);

      expect(text).toContain('[ON] base/Base');
      expect(text).toContain('[ON] runtime/Runtime');
      expect(text).toContain('id=');
      expect(text).toContain('priority=5');
      expect(text).toContain('channel=discord_text');
    });

    it('returns canonical error when store access throws', async () => {
      const brokenStore = {
        getAll: () => {
          throw new Error('list failed');
        },
      } as unknown as PromptLayerStore;

      const tool = gateToolWithCapabilities(
        createIdentityTool(brokenStore),
        () => accessForTier('nursery'),
      );
      const result = await tool.execute('broken-list', { action: 'list_layers' });

      expect(resultText(result)).toContain('prompt_layer_list failed');
      expect(resultText(result)).toContain('list failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  describe('identity action=get_layer', () => {
    it('allows reading base/operator layers at all tiers', async () => {
      const baseLayer = store.create({ type: 'base', name: 'Test Base', content: 'You are helpful.' });
      const operatorLayer = store.create({ type: 'operator', name: 'Operator', content: 'Run safely.' });
      const tiers: CapabilityTier[] = ['nursery', 'apprentice', 'autonomous'];

      for (const tier of tiers) {
        const tool = identityTool(tier);

        const baseResult = await tool.execute(`base-${tier}`, { action: 'get_layer', layer_id: baseLayer.id });
        const operatorResult = await tool.execute(`operator-${tier}`, { action: 'get_layer', layer_id: operatorLayer.id });

        expect(resultText(baseResult)).toContain('Type: base');
        expect(resultText(baseResult)).toContain('You are helpful.');
        expect(resultText(operatorResult)).toContain('Type: operator');
        expect(resultText(operatorResult)).toContain('Run safely.');
      }

      const custom = identityTool('custom', {}, ['identity.read']);
      const customResult = await custom.execute('custom-read', { action: 'get_layer', layer_id: baseLayer.id });
      expect(resultText(customResult)).toContain('Type: base');
    });

    it('handles prefix match', async () => {
      const layer = store.create({ type: 'base', name: 'Test', content: 'content' });
      const prefix = layer.id.slice(0, 8);

      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'get_layer', layer_id: prefix });
      const text = resultText(result);

      expect(text).toContain('Name: Test');
    });

    it('accepts layer.id as an alias for layer_id', async () => {
      const layer = store.create({ type: 'runtime', name: 'Alias', content: 'alias content' });
      const tool = identityTool('nursery');
      const result = await tool.execute('alias', { action: 'get_layer', layer: { id: layer.id.slice(0, 8) } });
      const text = resultText(result);

      expect(text).toContain('Name: Alias');
      expect(text).toContain('alias content');
    });

    it('returns not found for unknown id', async () => {
      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'get_layer', layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
      expect(result.details?.isError).toBe(true);
    });
  });

  describe('identity action=diff_layer', () => {
    it('compares current layer content against a historical version', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a\nline-b' });
      store.update(layer.id, 'line-a\nline-c', 'agent', {}, 'First rewrite');
      store.update(layer.id, 'line-a\nline-d', 'agent', {}, 'Second rewrite');

      const tool = identityTool('nursery');
      const result = await tool.execute('diff', { action: 'diff_layer', layer_id: layer.id, version: 1 });
      const text = resultText(result);

      expect(text).toContain('Identity diff for runtime/Runtime');
      expect(text).toContain('Compared versions: v1 -> v3');
      expect(text).toContain('- line-b');
      expect(text).toContain('+ line-d');
    });

    it('returns validation errors for unknown layer or invalid versions', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a' });
      const tool = identityTool('nursery');

      const missingLayer = await tool.execute('missing', {
        action: 'diff_layer',
        layer_id: 'missing',
        version: 1,
      });
      expect(resultText(missingLayer)).toContain('Layer not found');
      expect(missingLayer.details?.isError).toBe(true);

      const tooNew = await tool.execute('too-new', {
        action: 'diff_layer',
        layer_id: layer.id,
        version: 9,
      });
      expect(resultText(tooNew)).toContain('newer than current version');
      expect(tooNew.details?.isError).toBe(true);
    });

    it('accepts to_version as an alias for version', async () => {
      const layer = store.create({ type: 'runtime', name: 'Alias Diff', content: 'line-a\nline-b' });
      store.update(layer.id, 'line-a\nline-c', 'agent', {}, 'Alias diff rewrite');

      const tool = identityTool('nursery');
      const result = await tool.execute('alias-diff', {
        action: 'diff_layer',
        layer_id: layer.id,
        to_version: 1,
      });
      const text = resultText(result);

      expect(text).toContain('Identity diff for runtime/Alias Diff');
      expect(text).toContain('Compared versions: v1 -> v2');
      expect(text).toContain('- line-b');
      expect(text).toContain('+ line-c');
    });
  });

  describe('identity action=history', () => {
    it('returns who/what/when/why changelog entries', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a' });
      store.update(layer.id, 'line-b', 'agent', {}, 'Shift tone');
      store.update(layer.id, 'line-c', 'admin', {}, 'Operator calibration');

      const tool = identityTool('nursery');

      const result = await tool.execute('changelog', { action: 'history', layer_id: layer.id, limit: 10 });
      const text = resultText(result);

      expect(text).toContain('Identity changelog for runtime/Runtime');
      expect(text).toContain('by agent');
      expect(text).toContain('why: Shift tone');
      expect(text).toContain('what: +1/-1 lines');
    });
  });

  describe('identity action=update_layer', () => {
    it('denies base layer updates in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'base-nursery');
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'update_layer', layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.base');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('rejects canonical Character Foundation updates in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        const layer = createCanonicalFoundationLayer();
        const tool = identityTool(tier);

        const result = await tool.execute(`canonical-${tier}`, {
          action: 'update_layer',
          layer_id: layer.id,
          content: `blocked-${tier}`,
        });

        expect(resultText(result)).toContain(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
        expect(result.details?.isError).toBe(true);
        expect(store.getById(layer.id)?.content).toBe('original foundation');
      }
    });

    it('queues non-foundation base layer updates in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        const queue = new ConfirmationQueue({ idFactory: () => `base-${tier}-1` });
        const layer = createNonFoundationBaseLayer('Character Foundation', `alternate-${tier}`);
        const tool = identityTool(tier, {
          confirmationQueue: queue,
          getCapabilityTier: () => tier,
        });

        const result = await tool.execute(`test-${tier}`, {
          action: 'update_layer',
          layer_id: layer.id,
          content: `modified-${tier}`,
        });
        const text = resultText(result);

        expect(text).toContain('Prompt-layer update queued for confirmation');
        expect(queue.listPending()).toHaveLength(1);
        expect(store.getById(layer.id)?.content).toBe('original');

        const resolved = await queue.resolve({ id: `base-${tier}-1`, decision: 'approve' });
        expect(resolved.status).toBe('approved');
        expect(store.getById(layer.id)?.content).toBe(`modified-${tier}`);
        expect(store.getById(layer.id)?.updatedBy).toBe('admin:confirmation');
      }
    });

    it('fails closed for protected base updates when confirmation queue is missing', async () => {
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-no-queue');
      const tool = identityTool('autonomous', {
        getCapabilityTier: () => 'autonomous',
      });

      const result = await tool.execute('base-no-queue', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'blocked-change',
      });

      expect(resultText(result)).toContain('base identity layer updates require confirmation queue support');
      expect(result.details?.isError).toBe(true);
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('keeps protected prompt-layer proposals inert when denied and supports modified approval', async () => {
      let sequence = 0;
      const queue = new ConfirmationQueue({ idFactory: () => `protected-update-${++sequence}` });
      const deniedLayer = createNonFoundationBaseLayer('Denied Base', 'denied-base');
      const modifiedLayer = createNonFoundationBaseLayer('Modified Base', 'modified-base');
      const tool = identityTool('autonomous', {
        confirmationQueue: queue,
        getCapabilityTier: () => 'autonomous',
      });

      await tool.execute('denied-proposal', {
        action: 'update_layer',
        layer_id: deniedLayer.id,
        content: 'denied change',
        reason: 'Denied proposal',
      });
      const denied = await queue.resolve({ id: 'protected-update-1', decision: 'deny' });
      expect(denied.status).toBe('denied');
      expect(store.getById(deniedLayer.id)?.content).toBe('original');

      await tool.execute('modified-proposal', {
        action: 'update_layer',
        layer_id: modifiedLayer.id,
        content: 'agent proposed change',
        reason: 'Needs operator rewrite',
      });
      const modified = await queue.resolve({
        id: 'protected-update-2',
        decision: 'modify',
        modifiedParams: {
          ...queue.listPending()[0].params,
          content: 'operator modified change',
          reason: 'Operator approved adjusted wording',
        },
      });

      expect(modified.status).toBe('modified');
      expect(store.getById(modifiedLayer.id)?.content).toBe('operator modified change');
      expect(store.getById(modifiedLayer.id)?.updatedBy).toBe('admin:confirmation');
      expect(store.getLayerHistory(modifiedLayer.id).at(-1)?.reason).toBe('Operator approved adjusted wording');
    });

    it('rejects committing protected staged base updates', async () => {
      let now = 1_000;
      const manager = new IdentityCoolingOffManager({
        now: () => now,
        defaultCooldownMs: 5_000,
        idFactory: () => 'stage-1',
      });
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-stage');
      manager.stageBaseLayerEdit({
        layerId: layer.id,
        layerName: layer.name,
        previousContent: layer.content,
        nextContent: 'staged-change',
        requestedBy: 'agent',
        tier: 'autonomous',
      });
      const tool = identityTool('autonomous', {
        identityCoolingOff: manager,
        getCapabilityTier: () => 'autonomous',
      });

      now = 6_100;
      const committed = await tool.execute('commit-ready', {
        action: 'commit_stage',
        stage_id: 'stage-1',
      });
      expect(resultText(committed)).toContain('require operator confirmation');
      expect(committed.details?.isError).toBe(true);
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('allows cancelling staged base updates before commit', async () => {
      let sequence = 0;
      const manager = new IdentityCoolingOffManager({
        defaultCooldownMs: 5_000,
        idFactory: () => `stage-${++sequence}`,
      });
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-cancel');
      manager.stageBaseLayerEdit({
        layerId: layer.id,
        layerName: layer.name,
        previousContent: layer.content,
        nextContent: 'staged-change',
        requestedBy: 'agent',
        tier: 'autonomous',
      });
      const tool = identityTool('autonomous', {
        identityCoolingOff: manager,
        getCapabilityTier: () => 'autonomous',
      });

      const cancelled = await tool.execute('cancel', {
        action: 'cancel_stage',
        stage_id: 'stage-1',
      });
      expect(resultText(cancelled)).toContain('Cancelled staged prompt-layer change');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('denies operator layer updates in nursery tier', async () => {
      const layer = store.create({ type: 'operator', name: 'Operator', content: 'original' });
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'update_layer', layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.operator');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('queues operator layer updates in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        const queue = new ConfirmationQueue({ idFactory: () => `operator-${tier}-1` });
        const layer = store.create({ type: 'operator', name: `Operator-${tier}`, content: 'original' });
        const tool = identityTool(tier, {
          confirmationQueue: queue,
          getCapabilityTier: () => tier,
        });

        const result = await tool.execute(`test-${tier}`, {
          action: 'update_layer',
          layer_id: layer.id,
          content: `operator-${tier}`,
        });
        const text = resultText(result);

        expect(text).toContain('Prompt-layer update queued for confirmation');
        expect(store.getById(layer.id)?.content).toBe('original');

        const resolved = await queue.resolve({ id: `operator-${tier}-1`, decision: 'approve' });
        expect(resolved.status).toBe('approved');
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
      const tool = identityTool('nursery');

      const runtimeResult = await tool.execute('runtime', { action: 'update_layer', layer_id: runtime.id, content: 'runtime-updated' });
      const channelResult = await tool.execute('channel', { action: 'update_layer', layer_id: channel.id, content: 'channel-updated' });
      const taskResult = await tool.execute('task', { action: 'update_layer', layer_id: task.id, content: 'task-updated' });

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
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'update_layer', layer_id: prefix, content: 'updated' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
      expect(store.getById(layer.id)?.content).toBe('updated');
    });

    it('writes update reason into prompt history', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = identityTool('nursery');

      await tool.execute('reasoned-update', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'updated',
        reason: 'Need clearer guardrails',
      });

      const history = store.getLayerHistory(layer.id);
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('Need clearer guardrails');
    });
  });

  describe('identity action=rollback_layer', () => {
    it('denies base rollbacks in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'rollback-nursery');
      store.update(layer.id, 'base-v2', 'agent', {}, 'base update');
      const tool = identityTool('nursery');

      const result = await tool.execute('rollback-nursery', {
        action: 'rollback_layer',
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
      const tool = identityTool('nursery');

      const result = await tool.execute('rollback-runtime', {
        action: 'rollback_layer',
        layer_id: layer.id,
        version: 1,
        reason: 'Revert runtime prompt to known good',
      });

      expect(resultText(result)).toContain('Rolled back layer');
      expect(store.getById(layer.id)?.content).toBe('runtime-v1');

      const history = store.getLayerHistory(layer.id);
      expect(history.at(-1)?.reason).toBe('Revert runtime prompt to known good');
    });

    it('queues base rollbacks for confirmation in autonomous tier', async () => {
      const queue = new ConfirmationQueue({ idFactory: () => 'rollback-proposal-1' });
      const layer = createNonFoundationBaseLayer('Character Foundation', 'rollback-autonomous');
      store.update(layer.id, 'base-v2', 'agent', {}, 'base update');
      const tool = identityTool('autonomous', {
        confirmationQueue: queue,
        getCapabilityTier: () => 'autonomous',
      });

      const queued = await tool.execute('rollback-queue', {
        action: 'rollback_layer',
        layer_id: layer.id,
        version: 1,
      });
      expect(resultText(queued)).toContain('Prompt-layer rollback queued for confirmation');
      expect(queue.listPending()).toHaveLength(1);
      expect(store.getById(layer.id)?.content).toBe('base-v2');

      const resolved = await queue.resolve({ id: 'rollback-proposal-1', decision: 'approve' });
      expect(resolved.status).toBe('approved');
      expect(store.getById(layer.id)?.content).toBe('original');
      expect(store.getById(layer.id)?.updatedBy).toBe('admin:confirmation');
    });
  });

  describe('identity action=toggle_layer', () => {
    it('denies base toggles in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'toggle-nursery');
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'toggle_layer', layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.base');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('rejects canonical Character Foundation toggles in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        createNonFoundationBaseLayer('Fallback Base', `fallback-${tier}`);
        const layer = createCanonicalFoundationLayer();
        const tool = identityTool(tier);

        const result = await tool.execute(`toggle-canonical-${tier}`, { action: 'toggle_layer', layer_id: layer.id });

        expect(resultText(result)).toContain(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
        expect(result.details?.isError).toBe(true);
        expect(store.getById(layer.id)?.enabled).toBe(true);
      }
    });

    it('queues non-foundation base toggles in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        const queue = new ConfirmationQueue({ idFactory: () => `toggle-base-${tier}-1` });
        const baseA = createNonFoundationBaseLayer('Character Foundation', `main-clone-${tier}`);
        createNonFoundationBaseLayer(`Base-B-${tier}`, `support-${tier}`);
        const tool = identityTool(tier, {
          confirmationQueue: queue,
          getCapabilityTier: () => tier,
        });

        const result = await tool.execute(`toggle-${tier}`, { action: 'toggle_layer', layer_id: baseA.id });
        const text = resultText(result);

        expect(text).toContain('Prompt-layer toggle queued for confirmation');
        expect(store.getById(baseA.id)?.enabled).toBe(true);

        const resolved = await queue.resolve({ id: `toggle-base-${tier}-1`, decision: 'approve' });
        expect(resolved.status).toBe('approved');
        expect(store.getById(baseA.id)?.enabled).toBe(false);
      }
    });

    it('denies operator toggles in nursery tier', async () => {
      const layer = store.create({ type: 'operator', name: 'Operator', content: 'policy' });
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'toggle_layer', layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('Capability denied');
      expect(text).toContain('identity.write.operator');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('queues operator toggles in autonomous tier', async () => {
      for (const tier of ['autonomous'] as const) {
        const queue = new ConfirmationQueue({ idFactory: () => `toggle-operator-${tier}-1` });
        const layer = store.create({ type: 'operator', name: `Operator-${tier}`, content: 'policy' });
        const tool = identityTool(tier, {
          confirmationQueue: queue,
          getCapabilityTier: () => tier,
        });

        const result = await tool.execute(`toggle-${tier}`, { action: 'toggle_layer', layer_id: layer.id });
        const text = resultText(result);

        expect(text).toContain('Prompt-layer toggle queued for confirmation');
        expect(store.getById(layer.id)?.enabled).toBe(true);

        const resolved = await queue.resolve({ id: `toggle-operator-${tier}-1`, decision: 'approve' });
        expect(resolved.status).toBe('approved');
        expect(store.getById(layer.id)?.enabled).toBe(false);
      }
    });

    it('allows nursery runtime toggles', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      const tool = identityTool('nursery');

      const result = await tool.execute('test', { action: 'toggle_layer', layer_id: layer.id });
      const text = resultText(result);
      const payload = JSON.parse(text) as { layerId: string; enabled: boolean; state: string };

      expect(payload.layerId).toBe(layer.id);
      expect(payload.enabled).toBe(false);
      expect(payload.state).toBe('disabled');
      expect(store.getById(layer.id)?.enabled).toBe(false);
    });

    it('allows re-enabling a disabled layer', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      store.toggle(layer.id); // disable
      expect(store.getById(layer.id)?.enabled).toBe(false);

      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'toggle_layer', layer_id: layer.id });
      const text = resultText(result);
      const payload = JSON.parse(text) as { layerId: string; enabled: boolean; state: string };

      expect(payload.layerId).toBe(layer.id);
      expect(payload.enabled).toBe(true);
      expect(payload.state).toBe('enabled');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('returns not found for unknown layer', async () => {
      const tool = identityTool('nursery');
      const result = await tool.execute('test', { action: 'toggle_layer', layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
      expect(result.details?.isError).toBe(true);
    });

    it('rejects blank layer ids without matching the first prompt layer', async () => {
      const first = store.create({ type: 'runtime', name: 'First Runtime', content: 'first' });
      const tool = identityTool('nursery');
      const result = await tool.execute('blank-toggle', { action: 'toggle_layer', layer_id: '   ' });
      const text = resultText(result);

      expect(text).toContain('layer_id is required');
      expect(result.details?.isError).toBe(true);
      expect(store.getById(first.id)?.enabled).toBe(true);
    });
  });
});
