import { describe, expect, it, vi } from 'vitest';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { ShardFoldReviewRecord } from '../../../faculties/shards/fold-review.js';
import type { ActiveShard } from '../../../faculties/shards/manager.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { buildShardLineageEnvelope } from '../../../faculties/shards/result-lineage.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import { AdminShardFoldReviewDataService } from './shard-fold-review-service.js';

const PARENT_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const PARENT_B = createCompanionId('22222222-2222-4222-8222-222222222222');

function lineage(parent: typeof PARENT_A, shardId: string) {
  return buildShardLineageEnvelope({
    kind: 'spawn',
    coreCompanionId: parent,
    shardId,
    shardChannelId: `shard:${shardId}`,
    sourceMessage: {
      id: shardId,
      channelId: `shard:${shardId}`,
      channelType: 'api',
      authorId: parent,
      authorName: 'Test Companion',
      timestamp: new Date(1_720_000_000_000),
    },
  });
}

function review(parent: typeof PARENT_A, shardId: string): ShardFoldReviewRecord {
  return {
    schemaVersion: 1,
    shardId,
    channelId: `shard:${shardId}`,
    task: `task ${shardId}`,
    lineage: lineage(parent, shardId),
    validationPath: `/api/admin/shards/${shardId}`,
    reviewState: 'pending',
    createdAt: 1,
    updatedAt: 1,
    blockingReasons: [],
    visibilitySignals: {
      emotionalOrRelational: false,
      provenanceTags: [],
      emotionalOrRelationalOutputIds: [],
    },
    memoryItems: [],
    artifactItems: [],
  };
}

function active(parent: typeof PARENT_A, shardId: string): ActiveShard {
  return {
    id: shardId,
    name: shardId,
    task: `task ${shardId}`,
    startedAt: 1,
    channelId: `shard:${shardId}`,
    state: 'ready',
    stateReason: 'agent_initialized',
    health: 'healthy',
    lastTransitionAt: 1,
    lastHeartbeatAt: 1,
    heartbeatStaleAfterMs: 60_000,
    heartbeatDisconnectAfterMs: 180_000,
    capabilities: [],
    requiredCapabilities: [],
    capabilityGrant: {
      parentTier: 'autonomous',
      derivedTier: 'custom',
      tokens: [],
      ownerVersion: 'owner',
      grantDigest: 'grant',
      denialMask: [],
      derivationVersion: 'v1',
    },
    lineage: lineage(parent, shardId),
  };
}

function context(parentCompanionId: string): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    actor: {
      kind: 'fleet_principal',
      principalId: 'operator-a',
    },
    resource: {
      companionId: parentCompanionId,
    },
  } as unknown as GardenRequestContext;
}

function port(overrides: Partial<ShardExecutionPort> = {}): ShardExecutionPort {
  return {
    spawn: vi.fn(),
    delegateSatelliteSession: vi.fn(),
    getActiveCount: vi.fn(() => 0),
    getActiveShards: vi.fn(() => []),
    listFoldReviews: vi.fn(async () => []),
    getFoldReview: vi.fn(async () => null),
    resolveFoldReview: vi.fn(async () => null),
    getShardConfigurationSnapshot: vi.fn(() => null),
    updateShardConfigurationOverrides: vi.fn(() => ({
      ok: false,
      code: 'not_found',
      message: 'Shard not found',
    })),
    ...overrides,
  };
}

describe('AdminShardFoldReviewDataService parent scope', () => {
  it('filters active shards and fold reviews to the authenticated parent lineage', async () => {
    const manager = port({
      listFoldReviews: vi.fn(async () => [
        review(PARENT_A, 'shard-a'),
        review(PARENT_B, 'shard-b'),
      ]),
      getActiveShards: vi.fn(() => [
        active(PARENT_A, 'shard-a'),
        active(PARENT_B, 'shard-b'),
      ]),
    });
    const service = new AdminShardFoldReviewDataService(manager);

    await expect(service.listShardFoldReviews(context(PARENT_A))).resolves.toMatchObject({
      reviews: [{ shardId: 'shard-a' }],
      shards: [{ shardId: 'shard-a', parentCompanionId: PARENT_A }],
    });
  });

  it('returns the same generic absence for unknown and cross-parent fold reviews', async () => {
    const manager = port({
      getFoldReview: vi.fn(async shardId => (
        shardId === 'shard-b' ? review(PARENT_B, 'shard-b') : null
      )),
    });
    const service = new AdminShardFoldReviewDataService(manager);

    await expect(service.getShardFoldReview('unknown', context(PARENT_A))).resolves.toBeNull();
    await expect(service.getShardFoldReview('shard-b', context(PARENT_A))).resolves.toBeNull();
    await expect(service.resolveShardFoldReview({
      shardId: 'shard-b',
      decision: 'approve',
      actor: 'caller-controlled',
    }, context(PARENT_A))).resolves.toEqual({
      ok: false,
      message: 'Shard fold review not found',
    });
    expect(manager.resolveFoldReview).not.toHaveBeenCalled();
  });

  it('derives configuration parent and actor from the authenticated request context', async () => {
    const update = vi.fn(() => ({
      ok: false as const,
      code: 'not_found' as const,
      message: 'Shard not found',
    }));
    const get = vi.fn(() => null);
    const service = new AdminShardFoldReviewDataService(port({
      getShardConfigurationSnapshot: get,
      updateShardConfigurationOverrides: update,
    }));

    await service.getShardConfiguration('shard-a', context(PARENT_A));
    await service.updateShardConfiguration(
      'shard-a',
      { model: { provider: 'provider-a', model: 'bounded' } },
      context(PARENT_A),
    );

    expect(get).toHaveBeenCalledWith(PARENT_A, 'shard-a');
    expect(update).toHaveBeenCalledWith({
      parentCompanionId: PARENT_A,
      shardId: 'shard-a',
      actor: 'fleet-principal:operator-a',
      override: { model: { provider: 'provider-a', model: 'bounded' } },
    });
  });

  it('fails closed when no authenticated parent companion is present', async () => {
    const manager = port();
    const service = new AdminShardFoldReviewDataService(manager);

    await expect(service.listShardFoldReviews()).resolves.toEqual({ reviews: [], shards: [] });
    await expect(service.getShardConfiguration('shard-a')).resolves.toBeNull();
    await expect(service.updateShardConfiguration('shard-a', {})).resolves.toEqual({
      ok: false,
      code: 'not_found',
      message: 'Shard not found',
    });
    expect(manager.listFoldReviews).not.toHaveBeenCalled();
  });
});
