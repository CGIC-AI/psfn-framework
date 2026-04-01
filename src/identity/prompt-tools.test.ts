import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../types.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../capabilities/gate.js';
import { resolveTierCapabilityTokens } from '../capabilities/tiers.js';
import { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import { IdentityCoolingOffManager } from '../capabilities/safeguards.js';
import { PromptLayerStore } from './prompt-store.js';
import { CharacterCardVersionStore } from './card-versioning.js';
import type { CharacterCardV2 } from './types.js';
import { CARD_BACKED_FOUNDATION_PROMPT_MESSAGE } from './canonical-foundation.js';
import { createIdentityTool, type IdentityToolOptions } from './prompt-tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
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

const BASE_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'TestBot',
    description: 'A test character',
    personality: 'Friendly and helpful',
    scenario: 'Testing card changes',
    first_mes: 'Hello there!',
    mes_example: '{{user}}: hi\n{{char}}: hello!',
    system_prompt: 'Be concise.',
    post_history_instructions: 'Stay in character.',
    tags: ['test'],
    creator: 'tester',
  },
};

describe('identity tool', () => {
  let tmpDir: string;
  let store: PromptLayerStore;
  let cardStore: CharacterCardVersionStore;

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

  function createIdentityForTier(
    tier: CapabilityTier,
    options: IdentityToolOptions = {},
    customTokens: CapabilityToken[] = [],
  ) {
    return gateToolWithCapabilities(
      createIdentityTool(store, {
        cardStore,
        ...options,
      }),
      () => accessForTier(tier, customTokens),
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-identity-'));
    store = new PromptLayerStore(
      join(tmpDir, 'layers.json'),
      join(tmpDir, 'history.jsonl'),
    );

    const cardPath = join(tmpDir, 'character.json');
    const cardHistoryPath = join(tmpDir, 'character-history.jsonl');
    writeFileSync(cardPath, `${JSON.stringify(BASE_CARD, null, 2)}\n`, 'utf-8');
    cardStore = new CharacterCardVersionStore(cardPath, cardHistoryPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('read actions', () => {
    it('defaults empty-argument calls to list_layers', async () => {
      const tool = createIdentityForTier('nursery');
      const result = await tool.execute('identity-list', {});

      expect(resultText(result)).toBe('No prompt layers configured.');
    });

    it('lists prompt layers with details', async () => {
      store.create({ type: 'base', name: 'Base', content: 'base content' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'runtime content', priority: 5 });
      store.create({ type: 'channel', name: 'Discord', content: 'discord', channelType: 'discord_text' });

      const tool = createIdentityForTier('nursery');
      const result = await tool.execute('identity-list', { action: 'list_layers' });
      const text = resultText(result);

      expect(text).toContain('[ON] base/Base');
      expect(text).toContain('[ON] runtime/Runtime');
      expect(text).toContain('priority=5');
      expect(text).toContain('channel=discord_text');
    });

    it('gets base and operator layers at all tiers', async () => {
      const baseLayer = store.create({ type: 'base', name: 'Test Base', content: 'You are helpful.' });
      const operatorLayer = store.create({ type: 'operator', name: 'Operator', content: 'Run safely.' });

      for (const tier of ['nursery', 'apprentice', 'autonomous'] as const) {
        const tool = createIdentityForTier(tier);

        const baseResult = await tool.execute(`identity-base-${tier}`, {
          action: 'get_layer',
          layer_id: baseLayer.id,
        });
        const operatorResult = await tool.execute(`identity-operator-${tier}`, {
          action: 'get_layer',
          layer_id: operatorLayer.id,
        });

        expect(resultText(baseResult)).toContain('Type: base');
        expect(resultText(baseResult)).toContain('You are helpful.');
        expect(resultText(operatorResult)).toContain('Type: operator');
        expect(resultText(operatorResult)).toContain('Run safely.');
      }
    });

    it('returns diffs and history from prompt-layer versions', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'line-a\nline-b' });
      store.update(layer.id, 'line-a\nline-c', 'agent', {}, 'First rewrite');
      store.update(layer.id, 'line-a\nline-d', 'admin', {}, 'Second rewrite');

      const tool = createIdentityForTier('nursery');

      const diffResult = await tool.execute('identity-diff', {
        action: 'diff_layer',
        layer_id: layer.id,
        version: 1,
      });
      expect(resultText(diffResult)).toContain('Compared versions: v1 -> v3');
      expect(resultText(diffResult)).toContain('- line-b');
      expect(resultText(diffResult)).toContain('+ line-d');

      const historyResult = await tool.execute('identity-history', {
        action: 'history',
        layer_id: layer.id,
        limit: 10,
      });
      expect(resultText(historyResult)).toContain('Identity history for runtime/Runtime');
      expect(resultText(historyResult)).toContain('by agent');
      expect(resultText(historyResult)).toContain('by admin');
      expect(resultText(historyResult)).toContain('why: First rewrite');
    });
  });

  describe('prompt-layer mutations', () => {
    it('fails closed on ambiguous cross-surface parameters', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = createIdentityForTier('nursery');

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

    it('denies base-layer updates in nursery tier', async () => {
      const layer = createNonFoundationBaseLayer('Base', 'base-nursery');
      const tool = createIdentityForTier('nursery');

      const result = await tool.execute('identity-update-base', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'modified',
      });

      expect(resultText(result)).toContain('Capability denied');
      expect(resultText(result)).toContain('identity.write.base');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('rejects canonical foundation edits even when capability permits them', async () => {
      for (const tier of ['apprentice', 'autonomous'] as const) {
        const layer = createCanonicalFoundationLayer();
        const tool = createIdentityForTier(tier);

        const result = await tool.execute(`identity-canonical-${tier}`, {
          action: 'update_layer',
          layer_id: layer.id,
          content: `blocked-${tier}`,
        });

        expect(resultText(result)).toContain(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
        expect(result.details?.isError).toBe(true);
        expect(store.getById(layer.id)?.content).toBe('original foundation');
      }
    });

    it('updates runtime layers and records reasons', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = createIdentityForTier('nursery');

      const result = await tool.execute('identity-update-runtime', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'updated',
        reason: 'Need clearer guardrails',
      });

      expect(resultText(result)).toContain('Updated layer');
      expect(store.getById(layer.id)?.content).toBe('updated');
      expect(store.getLayerHistory(layer.id)).toHaveLength(1);
      expect(store.getLayerHistory(layer.id)[0].reason).toBe('Need clearer guardrails');
    });

    it('stages base updates with cooling-off and commits them via commit_stage', async () => {
      let now = 1_000;
      const manager = new IdentityCoolingOffManager({
        now: () => now,
        defaultCooldownMs: 5_000,
        idFactory: () => 'stage-1',
      });
      const layer = createNonFoundationBaseLayer('Character Foundation', 'alternate-stage');
      const tool = createIdentityForTier('apprentice', {
        getCapabilityTier: () => 'apprentice',
        identityCoolingOff: manager,
      });

      const staged = await tool.execute('identity-stage', {
        action: 'update_layer',
        layer_id: layer.id,
        content: 'staged-change',
      });
      expect(resultText(staged)).toContain('Staged base-layer update');
      expect(store.getById(layer.id)?.content).toBe('original');

      const tooSoon = await tool.execute('identity-commit-early', {
        action: 'commit_stage',
        stage_id: 'stage-1',
      });
      expect(resultText(tooSoon)).toContain('cooling off');
      expect(store.getById(layer.id)?.content).toBe('original');

      now = 6_100;
      const committed = await tool.execute('identity-commit-ready', {
        action: 'commit_stage',
        stage_id: 'stage-1',
      });
      expect(resultText(committed)).toContain('Committed staged prompt-layer change');
      expect(store.getById(layer.id)?.content).toBe('staged-change');
    });

    it('rolls runtime layers back and stages base rollbacks', async () => {
      const runtimeLayer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime-v1' });
      store.update(runtimeLayer.id, 'runtime-v2', 'agent', {}, 'tweak');
      store.update(runtimeLayer.id, 'runtime-v3', 'agent', {}, 'more tweak');
      const nurseryTool = createIdentityForTier('nursery');

      const rollbackResult = await nurseryTool.execute('identity-runtime-rollback', {
        action: 'rollback_layer',
        layer_id: runtimeLayer.id,
        version: 1,
        reason: 'Revert runtime prompt to known good',
      });
      expect(resultText(rollbackResult)).toContain('Rolled back layer');
      expect(store.getById(runtimeLayer.id)?.content).toBe('runtime-v1');
      expect(store.getLayerHistory(runtimeLayer.id).at(-1)?.reason).toBe('Revert runtime prompt to known good');

      let now = 5_000;
      const manager = new IdentityCoolingOffManager({
        now: () => now,
        defaultCooldownMs: 5_000,
        idFactory: () => 'rollback-stage-1',
      });
      const baseLayer = createNonFoundationBaseLayer('Character Foundation', 'rollback-apprentice');
      store.update(baseLayer.id, 'base-v2', 'agent', {}, 'base update');
      const apprenticeTool = createIdentityForTier('apprentice', {
        getCapabilityTier: () => 'apprentice',
        identityCoolingOff: manager,
      });

      const staged = await apprenticeTool.execute('identity-stage-rollback', {
        action: 'rollback_layer',
        layer_id: baseLayer.id,
        version: 1,
      });
      expect(resultText(staged)).toContain('Staged base-layer rollback');

      now = 10_100;
      const committed = await apprenticeTool.execute('identity-rollback-commit', {
        action: 'commit_stage',
        stage_id: 'rollback-stage-1',
      });
      expect(resultText(committed)).toContain('Committed staged prompt-layer change');
      expect(store.getById(baseLayer.id)?.content).toBe('original');
    });

    it('toggles runtime layers and denies base toggles in nursery tier', async () => {
      const baseLayer = createNonFoundationBaseLayer('Base', 'toggle-base');
      const runtimeLayer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      const nurseryTool = createIdentityForTier('nursery');

      const denied = await nurseryTool.execute('identity-toggle-base', {
        action: 'toggle_layer',
        layer_id: baseLayer.id,
      });
      expect(resultText(denied)).toContain('Capability denied');
      expect(resultText(denied)).toContain('identity.write.base');

      const toggled = await nurseryTool.execute('identity-toggle-runtime', {
        action: 'toggle_layer',
        layer_id: runtimeLayer.id,
      });
      expect(resultText(toggled)).toContain('disabled');
      expect(store.getById(runtimeLayer.id)?.enabled).toBe(false);
    });
  });

  describe('persona mutations', () => {
    it('updates low-risk persona fields through the identity surface', async () => {
      const tool = createIdentityForTier('autonomous', {
        getCapabilityTier: () => 'autonomous',
      });

      const result = await tool.execute('identity-persona-safe', {
        action: 'update_persona',
        tags: ['test', 'safe-update'],
        reason: 'Add classification tag',
      });

      expect(resultText(result)).toContain('Updated persona to v2');
      expect(cardStore.getCurrent().card.data.tags).toEqual(['test', 'safe-update']);
    });

    it('queues protected persona fields for confirmation when available', async () => {
      const queue = new ConfirmationQueue({ idFactory: () => 'card-protected-1' });
      const tool = createIdentityForTier('autonomous', {
        getCapabilityTier: () => 'autonomous',
        confirmationQueue: queue,
      });

      const queued = await tool.execute('identity-persona-protected', {
        action: 'update_persona',
        description: 'Updated protected description',
        reason: 'Refine identity',
      });

      expect(resultText(queued)).toContain('Persona update queued for confirmation');
      expect(resultText(queued)).toContain('Protected identity fields (description)');
      expect(queue.listPending()).toHaveLength(1);

      const resolved = await queue.resolve({
        id: 'card-protected-1',
        decision: 'approve',
      });
      expect(resolved.status).toBe('approved');
      expect(cardStore.getCurrent().card.data.description).toBe('Updated protected description');
    });

    it('fails closed when persona mutation is requested without a card store', async () => {
      const tool = gateToolWithCapabilities(
        createIdentityTool(store, {
          getCapabilityTier: () => 'autonomous',
        }),
        () => accessForTier('autonomous'),
      );

      const result = await tool.execute('identity-persona-missing-store', {
        action: 'update_persona',
        tags: ['test', 'missing-store'],
      });

      expect(resultText(result)).toContain('Character-card identity store is not configured');
      expect(result.details?.isError).toBe(true);
    });
  });
});
