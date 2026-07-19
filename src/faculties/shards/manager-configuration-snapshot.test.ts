import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { CAPABILITY_TIER_DEFAULTS } from '../../system/capabilities/tiers.js';
import {
  chargeSurface,
  resetRunChargeRollingWindowForTests,
} from '../../shared/telemetry/run-charge.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';
import { ShardManager } from './manager.js';

const CONFIG: SubstrateConfig = {
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
  companionId: '11111111-1111-4111-8111-111111111111',
  characterName: 'Test Companion',
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
    ],
  },
  providerRegistry: {
    schemaVersion: 1,
    providers: [{ id: 'provider-a', type: 'generic_openai', enabled: true }],
  },
};

const RESPONSE = {
  content: 'continue',
  channelId: 'shard:test',
  attachments: [],
  metadata: {
    model: 'bounded-model',
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 5,
  },
};

describe('ShardManager configuration snapshots and overrides', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let handleMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-configuration-snapshot-'));
    sessionStore = new SessionStore(dir);
    handleMessage = vi.spyOn(SubstrateAgent.prototype, 'handleMessage');
  });

  afterEach(() => {
    handleMessage.mockRestore();
    resetRunChargeRollingWindowForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies model/output/turn overrides at turn boundaries and removes state on completion', async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnBlocked = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const messages: Array<Parameters<SubstrateAgent['handleMessage']>[0]> = [];
    handleMessage.mockImplementation(async (message) => {
      messages.push(message);
      if (messages.length === 1) await firstTurnBlocked;
      return RESPONSE as never;
    });
    const auditTrail = { append: vi.fn() };
    const manager = new ShardManager({
      eventBus: new EventBus(),
      llmProvider: {
        stream: vi.fn(),
        complete: vi.fn(),
      } as LLMProviderPort,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: CONFIG,
      parentSystemPrompt: 'Inherited prompt.',
      auditTrail,
      snapshotParentCapabilityGrant: () => Object.freeze({
        tier: 'autonomous',
        customTokens: Object.freeze([]),
        grantedTokens: Object.freeze([...CAPABILITY_TIER_DEFAULTS.autonomous]),
      }),
    });

    const pending = manager.spawn({
      name: 'bounded-runtime',
      task: 'Run with a bounded override.',
      maxTurns: 3,
    });
    await vi.waitFor(() => {
      expect(manager.getActiveShards()).toHaveLength(1);
      expect(messages).toHaveLength(1);
    });
    const shardId = manager.getActiveShards()[0]!.id;

    expect(manager.getShardConfigurationSnapshot('companion-other', shardId)).toBeNull();
    expect(manager.updateShardConfigurationOverrides({
      parentCompanionId: 'companion-other',
      shardId,
      actor: 'fleet-principal:operator-b',
      override: { workerBudget: { maxTurns: 1 } },
    })).toMatchObject({ ok: false, code: 'not_found' });
    expect(manager.updateShardConfigurationOverrides({
      parentCompanionId: '11111111-1111-4111-8111-111111111111',
      shardId,
      actor: 'fleet-principal:operator-a',
      override: { capabilityTier: 'autonomous' },
    })).toMatchObject({ ok: false, code: 'invalid_override' });

    const updated = manager.updateShardConfigurationOverrides({
      parentCompanionId: '11111111-1111-4111-8111-111111111111',
      shardId,
      actor: 'fleet-principal:operator-a',
      override: {
        model: { provider: 'provider-a', model: 'bounded-model' },
        workerBudget: {
          maxTurns: 2,
          maxOutputTokens: 1_024,
          maxChargeUnits: 0,
        },
      },
    });
    expect(updated).toMatchObject({
      ok: true,
      snapshot: {
        inherited: {
          model: { model: 'parent-model' },
          workerBudget: { maxTurns: 3, maxOutputTokens: 4_096 },
        },
        override: {
          model: { model: 'bounded-model' },
          workerBudget: { maxTurns: 2, maxOutputTokens: 1_024, maxChargeUnits: 0 },
        },
        effective: {
          model: { model: 'bounded-model' },
          workerBudget: { maxTurns: 2, maxOutputTokens: 1_024, maxChargeUnits: 0 },
        },
      },
    });

    releaseFirstTurn?.();
    const result = await pending;
    expect(result.turns).toBe(2);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.routing?.modelOverride).toMatchObject({
      provider: 'provider-a',
      model: 'parent-model',
      maxTokens: 4_096,
    });
    expect(messages[1]?.routing?.modelOverride).toMatchObject({
      provider: 'provider-a',
      model: 'bounded-model',
      maxTokens: 1_024,
    });
    expect(manager.getShardConfigurationSnapshot('11111111-1111-4111-8111-111111111111', shardId)).toBeNull();
    expect(manager.updateShardConfigurationOverrides({
      parentCompanionId: '11111111-1111-4111-8111-111111111111',
      shardId,
      actor: 'fleet-principal:operator-a',
      override: { workerBudget: { maxTurns: 1 } },
    })).toMatchObject({ ok: false, code: 'not_found' });
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.configuration.override',
      expect.objectContaining({
        shardId,
        actor: 'fleet-principal:operator-a',
        decision: 'approved',
        previous: expect.any(Object),
        effective: expect.objectContaining({
          model: expect.objectContaining({ model: 'bounded-model' }),
        }),
        capabilityGrant: expect.objectContaining({
          grantDigest: expect.any(String),
        }),
      }),
    );
  });

  it('enforces a reduced per-shard charge budget without mutating the parent policy', async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnBlocked = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let calls = 0;
    handleMessage.mockImplementation(async () => {
      calls += 1;
      chargeSurface('externalModelConsult');
      if (calls === 1) await firstTurnBlocked;
      return RESPONSE as never;
    });
    const parentChargePolicy = makeTestChargePolicyConfig();
    const manager = new ShardManager({
      eventBus: new EventBus(),
      llmProvider: {
        stream: vi.fn(),
        complete: vi.fn(),
      } as LLMProviderPort,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...CONFIG, chargePolicy: parentChargePolicy },
      parentSystemPrompt: 'Inherited prompt.',
      snapshotParentCapabilityGrant: () => Object.freeze({
        tier: 'autonomous',
        customTokens: Object.freeze([]),
        grantedTokens: Object.freeze([...CAPABILITY_TIER_DEFAULTS.autonomous]),
      }),
    });

    const pending = manager.spawn({
      name: 'charge-bounded-runtime',
      task: 'Stop when the shard charge allocation is exhausted.',
      maxTurns: 2,
    });
    await vi.waitFor(() => {
      expect(manager.getActiveShards()).toHaveLength(1);
      expect(calls).toBe(1);
    });
    const shardId = manager.getActiveShards()[0]!.id;

    expect(manager.updateShardConfigurationOverrides({
      parentCompanionId: '11111111-1111-4111-8111-111111111111',
      shardId,
      actor: 'fleet-principal:operator-a',
      override: { workerBudget: { maxChargeUnits: 9 } },
    })).toMatchObject({ ok: true });
    expect(parentChargePolicy.runChargeQuotaByLane.shard).toBe(12);

    releaseFirstTurn?.();
    await expect(pending).rejects.toThrow('Charge quota exceeded for lane "shard"');
    expect(calls).toBe(2);
    expect(manager.getShardConfigurationSnapshot('11111111-1111-4111-8111-111111111111', shardId)).toBeNull();
  });
});
