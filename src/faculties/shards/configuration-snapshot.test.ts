import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';
import { buildShardLineageEnvelope } from './result-lineage.js';
import type { ShardCapabilityGrantEvidence } from './types.js';
import {
  applyShardConfigurationOverride,
  createShardConfigurationControl,
  parseShardConfigurationOverridePatch,
  resolveParentAllowedShardModels,
  ShardConfigurationRegistry,
  snapshotShardConfiguration,
} from './configuration-snapshot.js';

const PARENT = createCompanionId('companion-alpha');
const SHARD_ID = 'shard-config-test';
const CAPABILITY_GRANT: ShardCapabilityGrantEvidence = Object.freeze({
  parentTier: 'autonomous',
  derivedTier: 'custom',
  tokens: Object.freeze(['identity.read', 'memory.read']),
  ownerVersion: 'owner-version',
  grantDigest: 'grant-digest',
  denialMask: Object.freeze(['memory.delete', 'world.control']),
  derivationVersion: 'psfn.shard-grant.v1',
});

function config(): SubstrateConfig {
  return {
    primaryModel: 'parent-model',
    primaryProvider: 'provider-a',
    extractionModel: 'parent-model',
    extractionProvider: 'provider-a',
    primaryMaxTokens: 4_096,
    extractionMaxTokens: 2_048,
    characterCardPath: '',
    dataDir: './data',
    databasePath: ':memory:',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: PARENT,
    modelRoster: {
      chat: {
        provider: 'provider-a',
        model: 'parent-model',
        maxTokens: 4_096,
        contextWindow: 64_000,
      },
    },
    modelRegistry: {
      schemaVersion: 1,
      models: [
        {
          id: 'parent',
          rank: 100,
          identity: {
            provider: 'provider-a',
            model: 'parent-model',
            source: { type: 'test' },
          },
          purposes: [{ purpose: 'chat', primary: true }],
          capabilities: { maxOutputTokens: 4_096, contextWindow: 64_000 },
        },
        {
          id: 'bounded',
          rank: 90,
          identity: {
            provider: 'provider-a',
            model: 'bounded-model',
            source: { type: 'test' },
          },
          purposes: [{ purpose: 'chat', primary: false }],
          capabilities: { maxOutputTokens: 2_048, contextWindow: 32_000 },
        },
        {
          id: 'disabled-provider',
          rank: 80,
          identity: {
            provider: 'provider-disabled',
            model: 'disabled-model',
            source: { type: 'test' },
          },
          purposes: [{ purpose: 'chat', primary: false }],
          capabilities: { maxOutputTokens: 1_024, contextWindow: 16_000 },
        },
      ],
    },
    providerRegistry: {
      schemaVersion: 1,
      providers: [
        { id: 'provider-a', type: 'generic_openai', enabled: true },
        { id: 'provider-disabled', type: 'generic_openai', enabled: false },
      ],
    },
    chargePolicy: makeTestChargePolicyConfig(),
  };
}

function control() {
  const lineage = buildShardLineageEnvelope({
    kind: 'spawn',
    coreCompanionId: PARENT,
    shardId: SHARD_ID,
    shardChannelId: `shard:${SHARD_ID}`,
    sourceMessage: {
      id: SHARD_ID,
      channelId: `shard:${SHARD_ID}`,
      channelType: 'api',
      authorId: PARENT,
      authorName: 'Companion Alpha',
      timestamp: new Date(1_720_000_000_000),
    },
  });
  return createShardConfigurationControl({
    shardId: SHARD_ID,
    parentCompanionId: PARENT,
    lifecycleState: 'ready',
    health: 'healthy',
    capturedAt: 1_720_000_000_000,
    maxTurns: 4,
    capabilityGrant: CAPABILITY_GRANT,
    lineage,
    config: config(),
    parentSystemPrompt: 'Inherited parent prompt.',
  });
}

describe('shard configuration snapshots', () => {
  it('separates inherited, override, and effective values with read-only authority evidence', () => {
    const snapshot = snapshotShardConfiguration(control(), config());

    expect(snapshot).toMatchObject({
      shardId: SHARD_ID,
      parentCompanionId: PARENT,
      inherited: {
        model: { provider: 'provider-a', model: 'parent-model' },
        workerBudget: { maxTurns: 4, maxOutputTokens: 4_096, maxChargeUnits: 12 },
        readOnly: {
          capabilityTier: { parent: 'autonomous', effective: 'custom' },
          trust: { source: 'parent_runtime', mutable: false },
          prompts: { source: 'parent_launch_snapshot', mutable: false },
        },
      },
      override: { model: null, workerBudget: {}, readOnly: null },
      effective: {
        model: { provider: 'provider-a', model: 'parent-model' },
        workerBudget: { maxTurns: 4, maxOutputTokens: 4_096, maxChargeUnits: 12 },
      },
    });
    expect(snapshot.source.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.effective.readOnly.capabilityGrant).toEqual(CAPABILITY_GRANT);
    expect(snapshot.allowed.models.map(model => model.model)).toEqual([
      'parent-model',
      'bounded-model',
    ]);
  });

  it('applies only a parent-allowed model and downward-bounded worker budget', () => {
    const state = control();
    applyShardConfigurationOverride(
      state,
      parseShardConfigurationOverridePatch({
        model: { provider: 'provider-a', model: 'bounded-model' },
        workerBudget: {
          maxTurns: 2,
          maxOutputTokens: 1_024,
          maxChargeUnits: 3.5,
        },
      }),
      config(),
      'fleet-principal:operator-a',
      1_720_000_000_100,
    );

    const snapshot = snapshotShardConfiguration(state, config());
    expect(snapshot.override).toEqual({
      model: { provider: 'provider-a', model: 'bounded-model' },
      workerBudget: {
        maxTurns: 2,
        maxOutputTokens: 1_024,
        maxChargeUnits: 3.5,
      },
      readOnly: null,
    });
    expect(snapshot.effective.model).toMatchObject({
      provider: 'provider-a',
      model: 'bounded-model',
    });
    expect(snapshot.updatedBy).toBe('fleet-principal:operator-a');
    expect(snapshot.effective.readOnly.capabilityGrant).toEqual(CAPABILITY_GRANT);
  });

  it('rolls back the override and charge quota when the success audit fails', () => {
    const state = control();
    const chargePolicy = makeTestChargePolicyConfig();
    const auditError = new Error('audit sink unavailable');
    let auditShouldThrow = false;
    const auditTrail = {
      append: vi.fn((event: string, details?: Record<string, unknown>) => {
        if (
          auditShouldThrow
          && event === 'shard.configuration.override'
          && details?.decision === 'approved'
        ) {
          throw auditError;
        }
      }),
    };
    const registry = new ShardConfigurationRegistry({
      liveParentConfig: config,
      auditTrail,
    });
    registry.register(state, chargePolicy);
    expect(registry.update({
      parentCompanionId: PARENT,
      shardId: SHARD_ID,
      actor: 'fleet-principal:operator-before',
      override: { workerBudget: { maxChargeUnits: 8 } },
    })).toMatchObject({ ok: true });
    const before = registry.getSnapshot(PARENT, SHARD_ID);
    auditShouldThrow = true;

    expect(() => registry.update({
      parentCompanionId: PARENT,
      shardId: SHARD_ID,
      actor: 'fleet-principal:operator-a',
      override: {
        model: { provider: 'provider-a', model: 'bounded-model' },
        workerBudget: {
          maxTurns: 2,
          maxOutputTokens: 1_024,
          maxChargeUnits: 3.5,
        },
      },
    })).toThrow(auditError);

    expect(registry.getSnapshot(PARENT, SHARD_ID)).toEqual(before);
    expect(chargePolicy.runChargeQuotaByLane.shard).toBe(8);
    expect(auditTrail.append).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ trust: { level: 'owner' } }, 'unknown keys: trust'],
    [{ capabilityTier: 'autonomous' }, 'unknown keys: capabilityTier'],
    [{ prompts: null }, 'unknown keys: prompts'],
    [{ model: { provider: 'provider-a', model: 'bounded-model', tier: 'autonomous' } }, 'unknown keys: tier'],
    [{ workerBudget: { maxTurns: 2, wallTimeMs: 1 } }, 'unknown keys: wallTimeMs'],
    [{ workerBudget: {} }, 'at least one approved budget key'],
  ])('rejects unknown or non-mutable fields in %j', (payload, message) => {
    expect(() => parseShardConfigurationOverridePatch(payload)).toThrow(message);
  });

  it.each([
    [{ workerBudget: { maxTurns: 5 } }, 'maxTurns'],
    [{ workerBudget: { maxOutputTokens: 4_097 } }, 'maxOutputTokens'],
    [{ workerBudget: { maxChargeUnits: 12.1 } }, 'maxChargeUnits'],
    [{ model: { provider: 'provider-a', model: 'unknown-model' } }, 'not eligible'],
    [{ model: { provider: 'provider-disabled', model: 'disabled-model' } }, 'not eligible'],
  ])('rejects widening or provider-disallowed override %j', (payload, message) => {
    const state = control();
    const patch = parseShardConfigurationOverridePatch(payload);
    expect(() => applyShardConfigurationOverride(
      state,
      patch,
      config(),
      'fleet-principal:operator-a',
    )).toThrow(message);
    expect(state.override).toEqual({ model: null, workerBudget: {}, readOnly: null });
  });

  it('requires complete lineage matching the authenticated parent and shard', () => {
    const state = control();
    expect(() => createShardConfigurationControl({
      shardId: 'different-shard',
      parentCompanionId: PARENT,
      lifecycleState: 'ready',
      health: 'healthy',
      capturedAt: 1,
      maxTurns: 1,
      capabilityGrant: CAPABILITY_GRANT,
      lineage: state.lineage,
      config: config(),
      parentSystemPrompt: 'prompt',
    })).toThrow('complete parent-owned lineage');
  });

  it('fails closed when an authoritative registry omits the parent model', () => {
    const parentConfig = config();
    parentConfig.modelRegistry = {
      schemaVersion: 1,
      models: [],
    };

    expect(() => resolveParentAllowedShardModels(parentConfig))
      .toThrow('Parent primary model is not eligible');
  });

  it('fails closed when registry-free inheritance names a disabled provider', () => {
    const parentConfig = config();
    delete parentConfig.modelRegistry;
    parentConfig.providerRegistry = {
      schemaVersion: 1,
      providers: [{ id: 'provider-a', type: 'generic_openai', enabled: false }],
    };

    expect(() => resolveParentAllowedShardModels(parentConfig))
      .toThrow('Parent primary provider is disabled');
  });
});
