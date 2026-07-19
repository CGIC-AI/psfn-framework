import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  CapabilityAccess,
  CapabilityGrantSnapshot,
} from '../../system/capabilities/access.js';
import { CAPABILITY_TIER_DEFAULTS } from '../../system/capabilities/tiers.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import type { PostgresShardSchemaLifecycle } from '../../persistence/postgres/shard-schema-lifecycle.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { ShardManager, type ShardManagerDeps } from './manager.js';

const TEST_CONFIG: SubstrateConfig = {
  primaryModel: 'test-model',
  primaryProvider: 'test',
  extractionModel: 'test-model',
  extractionProvider: 'test',
  discordToken: '',
  discordBotId: '',
  characterCardPath: '',
  dataDir: './data',
  databasePath: ':memory:',
  sessionMessageLimit: 30,
  memoryRetrievalLimit: 15,
  extractionInterval: 5,
  primaryMaxTokens: 16_384,
  extractionMaxTokens: 8_192,
  maintenanceIntervalMs: 300_000,
  defaultContextWindow: 128_000,
  extractionThresholdPct: 30,
  compactionThresholdPct: 70,
  companionId: 'companion-test',
  characterName: 'Companion',
  modelRoster: {
    chat: {
      model: 'test-model',
      provider: 'test',
      maxTokens: 16_384,
      contextWindow: 128_000,
    },
  },
};

const RESPONSE = {
  content: 'bounded response',
  channelId: 'shard:test',
  attachments: [],
  metadata: {
    model: 'test-model',
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 5,
  },
};

function mockLLM(): LLMProviderPort {
  return {
    stream: vi.fn(),
    complete: vi.fn(),
  };
}

describe('ShardManager digest-bound capability launches', () => {
  let dir: string;
  let eventBus: EventBus;
  let sessionStore: SessionStore;
  let handleMessage: ReturnType<typeof vi.spyOn>;
  let setCapabilityAccess: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-capability-launch-'));
    eventBus = new EventBus();
    sessionStore = new SessionStore(dir);
    handleMessage = vi.spyOn(SubstrateAgent.prototype, 'handleMessage')
      .mockResolvedValue(RESPONSE as never);
    setCapabilityAccess = vi.spyOn(SubstrateAgent.prototype, 'setCapabilityAccess');
  });

  afterEach(() => {
    handleMessage.mockRestore();
    setCapabilityAccess.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function createManager(
    snapshotParentCapabilityGrant: ShardManagerDeps['snapshotParentCapabilityGrant'],
    overrides: Partial<ShardManagerDeps> = {},
  ): ShardManager {
    return new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      snapshotParentCapabilityGrant,
      ...overrides,
    });
  }

  it('binds one custom snapshot to access, active/result/audit evidence, and routing non-widening', async () => {
    const snapshot: CapabilityGrantSnapshot = Object.freeze({
      tier: 'custom',
      customTokens: Object.freeze([
        'identity.read',
        'identity.write.runtime',
        'memory.write',
        'memory.delete',
        'git.read',
        'lifecycle.restart',
        'shard.spawn',
        'world.control',
      ]),
      grantedTokens: Object.freeze([
        'identity.read',
        'identity.write.runtime',
        'memory.write',
        'memory.delete',
        'git.read',
        'lifecycle.restart',
        'shard.spawn',
        'world.control',
      ]),
    });
    const snapshotParentCapabilityGrant = vi.fn(() => snapshot);
    const expected = deriveShardCapabilityGrant({
      companionId: 'companion-test',
      tier: snapshot.tier,
      customTokens: snapshot.customTokens,
    });
    const auditTrail = { append: vi.fn() };
    let turnAccess: CapabilityAccess | undefined;
    handleMessage.mockImplementationOnce(async function (this: SubstrateAgent) {
      turnAccess = (this as unknown as {
        resolveCapabilityAccess(): CapabilityAccess;
      }).resolveCapabilityAccess();
      await new Promise(resolve => setTimeout(resolve, 30));
      return RESPONSE as never;
    });
    const manager = createManager(snapshotParentCapabilityGrant, {
      auditTrail,
      config: { ...TEST_CONFIG, capabilityTier: 'autonomous' },
    });

    const pending = manager.spawn({
      name: 'digest-bound-custom',
      task: 'Inspect the bounded grant.',
      capabilities: ['world.control', 'external.email', 'memory.delete'],
      requiredCapabilities: ['world.control', 'external.email', 'memory.delete'],
    });
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(snapshotParentCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(manager.getActiveShards()[0]?.capabilityGrant).toEqual({
      parentTier: 'custom',
      derivedTier: 'custom',
      tokens: expected.tokens,
      ownerVersion: expected.ownerVersion,
      grantDigest: expected.grantDigest,
      denialMask: expected.denialMask,
      derivationVersion: expected.derivationVersion,
    });

    const result = await pending;
    const injectedAccess = setCapabilityAccess.mock.calls.at(-1)?.[0] as CapabilityAccess;
    expect(turnAccess).toBe(injectedAccess);
    expect([...injectedAccess.getGrantedTokens()]).toEqual(expected.tokens);
    expect(result.capabilityGrant.tokens).toEqual([
      'identity.read',
      'identity.write.runtime',
      'memory.write',
      'git.read',
      'shard.spawn',
    ]);
    expect(result.capabilityGrant.tokens).not.toContain('world.control');
    expect(result.capabilityGrant.tokens).not.toContain('memory.delete');
    expect(result.capabilityGrant.tokens).not.toContain('external.email');
    expect(result.capabilities).toEqual(['world.control', 'external.email', 'memory.delete']);
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.spawn.start',
      expect.objectContaining({
        capabilityGrant: expect.objectContaining({
          parentTier: 'custom',
          ownerVersion: expected.ownerVersion,
          grantDigest: expected.grantDigest,
          tokens: expected.tokens,
        }),
      }),
    );
    expect(Object.isFrozen(result.capabilityGrant)).toBe(true);
    expect(Object.isFrozen(result.capabilityGrant.tokens)).toBe(true);
  });

  it.each(['apprentice', 'autonomous'] as const)(
    'derives an exact non-widening grant from the %s default parent tier',
    async (tier) => {
    const snapshot: CapabilityGrantSnapshot = Object.freeze({
      tier,
      customTokens: Object.freeze([]),
      grantedTokens: Object.freeze([...CAPABILITY_TIER_DEFAULTS[tier]]),
    });
    const snapshotParentCapabilityGrant = vi.fn(() => snapshot);
    const expected = deriveShardCapabilityGrant({
      companionId: 'companion-test',
      tier,
      customTokens: [],
    });
    const manager = createManager(snapshotParentCapabilityGrant);

    const result = await manager.spawn({ name: 'default-parent', task: 'test' });

    expect(snapshotParentCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(result.capabilityGrant).toEqual(expect.objectContaining({
      parentTier: tier,
      derivedTier: 'custom',
      tokens: expected.tokens,
      ownerVersion: expected.ownerVersion,
      grantDigest: expected.grantDigest,
    }));
    expect(result.capabilityGrant.tokens).toContain('identity.write.runtime');
    expect(result.capabilityGrant.tokens).toContain('memory.write');
    expect(result.capabilityGrant.tokens).not.toContain('identity.write.base');
    expect(result.capabilityGrant.tokens).not.toContain('identity.write.operator');
    expect(result.capabilityGrant.tokens).not.toContain('lifecycle.rebuild');
    },
  );

  it.each([
    {
      name: 'missing shard.spawn',
      snapshotParentCapabilityGrant: () => ({
        tier: 'custom',
        customTokens: ['identity.read'],
        grantedTokens: ['identity.read'],
      }) as CapabilityGrantSnapshot,
      error: /does not grant shard\.spawn/,
    },
    {
      name: 'a nursery parent without shard.spawn',
      snapshotParentCapabilityGrant: () => ({
        tier: 'nursery',
        customTokens: [],
        grantedTokens: [...CAPABILITY_TIER_DEFAULTS.nursery],
      }) as CapabilityGrantSnapshot,
      error: /does not grant shard\.spawn/,
    },
    {
      name: 'malformed custom owner token',
      snapshotParentCapabilityGrant: () => ({
        tier: 'custom',
        customTokens: ['shard.spawn', 'unknown.capability'],
        grantedTokens: ['shard.spawn'],
      }) as unknown as CapabilityGrantSnapshot,
      error: /unknown capability token/,
    },
    {
      name: 'an unavailable snapshot provider',
      snapshotParentCapabilityGrant: () => {
        throw new Error('capability owner unavailable');
      },
      error: /capability owner unavailable/,
    },
  ])('denies $name before registration, schema, tools, or LLM work', async ({
    snapshotParentCapabilityGrant: resolveSnapshot,
    error,
  }) => {
    const snapshotParentCapabilityGrant = vi.fn(resolveSnapshot);
    const deriveSchema = vi.fn();
    const prepareSchema = vi.fn();
    const toolCatalogProvider = vi.fn(() => ({ core: [], extended: [] }));
    const auditTrail = { append: vi.fn() };
    const manager = createManager(snapshotParentCapabilityGrant, {
      config: {
        ...TEST_CONFIG,
        multiCompanion: true,
        postgresSchema: 'companion_test',
      },
      auditTrail,
      toolCatalogProvider,
      shardPostgresLifecycle: {
        derive: deriveSchema,
        prepare: prepareSchema,
      } as unknown as PostgresShardSchemaLifecycle,
    });

    await expect(manager.spawn({ name: 'fail-closed', task: 'test' })).rejects.toThrow(error);

    expect(snapshotParentCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(deriveSchema).not.toHaveBeenCalled();
    expect(prepareSchema).not.toHaveBeenCalled();
    expect(toolCatalogProvider).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(manager.getActiveShards()).toEqual([]);
    expect(auditTrail.append).not.toHaveBeenCalledWith('shard.spawn.start', expect.anything());
  });

  it('binds Wyoming delegation to the same immutable custom access and digest evidence', async () => {
    const snapshot: CapabilityGrantSnapshot = Object.freeze({
      tier: 'custom',
      customTokens: Object.freeze([
        'identity.read',
        'memory.write',
        'memory.delete',
        'external.web',
        'shard.spawn',
        'world.control',
      ]),
      grantedTokens: Object.freeze([
        'identity.read',
        'memory.write',
        'memory.delete',
        'external.web',
        'shard.spawn',
        'world.control',
      ]),
    });
    const snapshotParentCapabilityGrant = vi.fn(() => snapshot);
    const expected = deriveShardCapabilityGrant({
      companionId: 'companion-test',
      tier: 'custom',
      customTokens: snapshot.customTokens,
    });
    const auditTrail = { append: vi.fn() };
    const manager = createManager(snapshotParentCapabilityGrant, {
      auditTrail,
      config: { ...TEST_CONFIG, capabilityTier: 'autonomous' },
    });

    const result = await manager.delegateSatelliteSession({
      message: {
        id: 'wyoming-digest-message',
        channelId: 'api:wyoming:site-test:satellite-test',
        channelType: 'api',
        authorId: 'test-user',
        authorName: 'Test User',
        content: 'perform a bounded check',
        isDirectMessage: true,
        timestamp: new Date('2026-07-18T12:00:00.000Z'),
      },
      routing: {
        connectionId: 'connection-test',
        sessionId: 'session-test',
        turnId: 'turn-test',
        siteId: 'site-test',
        satelliteId: 'satellite-test',
      },
    });

    expect(snapshotParentCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(result.capabilityGrant).toEqual(expect.objectContaining({
      parentTier: 'custom',
      derivedTier: 'custom',
      tokens: expected.tokens,
      ownerVersion: expected.ownerVersion,
      grantDigest: expected.grantDigest,
    }));
    expect(result.capabilityGrant.tokens).toEqual([
      'identity.read',
      'memory.write',
      'external.web',
      'shard.spawn',
    ]);
    expect(result.capabilities).toEqual([
      'wyoming',
      'wyoming:site-test',
      'wyoming:site-test:satellite-test',
    ]);
    expect(auditTrail.append).toHaveBeenCalledWith(
      'satellite.shard.delegate.start',
      expect.objectContaining({
        capabilityGrant: expect.objectContaining({
          ownerVersion: expected.ownerVersion,
          grantDigest: expected.grantDigest,
          tokens: expected.tokens,
        }),
      }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'satellite.shard.delegate.end',
      expect.objectContaining({
        status: 'completed',
        capabilityGrant: expect.objectContaining({
          ownerVersion: expected.ownerVersion,
          grantDigest: expected.grantDigest,
        }),
      }),
    );
  });

  it('denies Wyoming delegation without shard.spawn before delegation or LLM side effects', async () => {
    const snapshotParentCapabilityGrant = vi.fn((): CapabilityGrantSnapshot => ({
      tier: 'custom',
      customTokens: ['identity.read'],
      grantedTokens: ['identity.read'],
    }));
    const auditTrail = { append: vi.fn() };
    const manager = createManager(snapshotParentCapabilityGrant, { auditTrail });

    await expect(manager.delegateSatelliteSession({
      message: {
        id: 'wyoming-denied-message',
        channelId: 'api:wyoming:site-test:satellite-test',
        channelType: 'api',
        authorId: 'test-user',
        authorName: 'Test User',
        content: 'attempt a bounded check',
        isDirectMessage: true,
        timestamp: new Date('2026-07-18T12:00:00.000Z'),
      },
      routing: {
        siteId: 'site-test',
        satelliteId: 'satellite-test',
      },
    })).rejects.toThrow(/does not grant shard\.spawn/);

    expect(snapshotParentCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(manager.getActiveShards()).toEqual([]);
    expect(auditTrail.append).not.toHaveBeenCalledWith(
      'satellite.shard.delegate.start',
      expect.anything(),
    );
    expect(auditTrail.append).not.toHaveBeenCalledWith('shard.spawn.start', expect.anything());
  });
});
