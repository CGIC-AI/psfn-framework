import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  createShardParentIcpEnvelope,
  type ShardParentIcpEnvelope,
} from '../../shared/contracts/shard-parent-icp.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { createPolicyGovernedShardParentIcpDelivery } from './shard-parent-icp-ingress.js';

const PARENT_COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const FOREIGN_COMPANION_ID = createCompanionId('22222222-2222-4222-8222-222222222222');
const SHARD_ID = 'shard-live-1';
const MESSAGE_ID = 'shard-parent-icp-message-1';
const DELIVERED_AT = new Date('2026-07-18T12:00:00.000Z');

function response(): AgentResponse {
  return {
    content: 'Parent received the shard update.',
    channelId: `companion-shard:${PARENT_COMPANION_ID}:${SHARD_ID}`,
    metadata: {
      model: 'test-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

function envelope(
  overrides: Partial<ShardParentIcpEnvelope> = {},
): ShardParentIcpEnvelope {
  return {
    ...createShardParentIcpEnvelope({
      parentCompanionId: PARENT_COMPANION_ID,
      shardId: SHARD_ID,
      direction: 'shard_to_parent',
      content: 'Bearer private-token should not reach cognition',
    }),
    ...overrides,
  };
}

describe('createPolicyGovernedShardParentIcpDelivery', () => {
  it('screens shard output and enters the ordinary companion turn with exact lineage', async () => {
    const snapshot = {
      envelopeId: 'intake-envelope-1',
      sourceClass: 'subagent_output',
    };
    const screen = vi.fn()
      .mockResolvedValueOnce({
        effectiveText: '[REDACTED:credential] should not reach cognition',
        snapshot,
      })
      .mockResolvedValueOnce({
        effectiveText: 'Parent received the shard update.',
        snapshot: { ...snapshot, envelopeId: 'intake-envelope-2' },
      });
    const handleMessage = vi.fn(async (_message: SubstrateMessage) => response());
    const waitForIdle = vi.fn(async () => {});
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: { screen } as never,
      agentLoop: { handleMessage, waitForIdle },
      idFactory: () => MESSAGE_ID,
      now: () => DELIVERED_AT,
    });

    await expect(delivery.deliverOrdinaryIcp(envelope())).resolves.toEqual({
      schemaVersion: 1,
      routingCompanionId: PARENT_COMPANION_ID,
      lineage: {
        parentCompanionId: PARENT_COMPANION_ID,
        shardId: SHARD_ID,
      },
      direction: 'parent_to_shard',
      content: 'Parent received the shard update.',
    });

    expect(screen).toHaveBeenCalledWith(
      'Bearer private-token should not reach cognition',
      {
        sourceClass: 'subagent_output',
        origin: {
          ref: `shard-parent-icp:${PARENT_COMPANION_ID}:${SHARD_ID}:shard_to_parent`,
        },
        scope: 'context',
        sourceChannelId: `companion-shard:${PARENT_COMPANION_ID}:${SHARD_ID}`,
      },
    );
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledWith({
        id: MESSAGE_ID,
        channelId: `companion-shard:${PARENT_COMPANION_ID}:${SHARD_ID}`,
        channelType: 'companion',
        authorId: `shard:${SHARD_ID}`,
        authorName: 'Shard',
        content: '[REDACTED:credential] should not reach cognition',
        timestamp: DELIVERED_AT,
        isDirectMessage: true,
        routing: {
          source: 'companion',
          authorIsMachineIntelligence: true,
          shardParentIcp: {
            schemaVersion: 1,
            routingCompanionId: PARENT_COMPANION_ID,
            lineage: {
              parentCompanionId: PARENT_COMPANION_ID,
              shardId: SHARD_ID,
            },
            direction: 'shard_to_parent',
          },
          intakeEnvelopes: [snapshot],
        },
      });
    });
    expect(screen).toHaveBeenNthCalledWith(
      2,
      'Parent received the shard update.',
      {
        sourceClass: 'subagent_output',
        origin: {
          ref: `shard-parent-icp:${PARENT_COMPANION_ID}:${SHARD_ID}:parent_to_shard`,
        },
        scope: 'context',
        sourceChannelId: `companion-shard:${PARENT_COMPANION_ID}:${SHARD_ID}`,
      },
    );
  });

  it('rejects foreign, inconsistent, and wrong-direction envelopes before cognition', async () => {
    const handleMessage = vi.fn(async (_message: SubstrateMessage) => response());
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: null,
      agentLoop: { handleMessage, waitForIdle: vi.fn(async () => {}) },
    });

    await expect(delivery.deliverOrdinaryIcp(envelope({
      routingCompanionId: FOREIGN_COMPANION_ID,
      lineage: {
        parentCompanionId: FOREIGN_COMPANION_ID,
        shardId: SHARD_ID,
      },
    }))).rejects.toThrow(/foreign parent companion/u);
    await expect(delivery.deliverOrdinaryIcp(envelope({
      lineage: {
        parentCompanionId: FOREIGN_COMPANION_ID,
        shardId: SHARD_ID,
      },
    }))).rejects.toThrow(/routing and lineage parent mismatch/u);
    await expect(delivery.deliverOrdinaryIcp(envelope({
      direction: 'parent_to_shard',
    }))).rejects.toThrow(/only accepts shard-to-parent/u);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('rejects coercible and unknown envelope fields before cognition', async () => {
    const handleMessage = vi.fn(async (_message: SubstrateMessage) => response());
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: null,
      agentLoop: { handleMessage, waitForIdle: vi.fn(async () => {}) },
    });
    const coercibleVersion = {
      ...envelope(),
      schemaVersion: '1junk',
    } as unknown as ShardParentIcpEnvelope;
    const unknownField = {
      ...envelope(),
      peerCompanionId: FOREIGN_COMPANION_ID,
    } as ShardParentIcpEnvelope;

    await expect(delivery.deliverOrdinaryIcp(coercibleVersion))
      .rejects.toThrow(/schema version is unsupported/u);
    await expect(delivery.deliverOrdinaryIcp(unknownField))
      .rejects.toThrow(/unknown field "peerCompanionId"/u);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('queues while the parent is busy, then returns the exact parent response', async () => {
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Agent is already processing a prompt'))
      .mockResolvedValueOnce(response());
    const waitForIdle = vi.fn(async () => {
      await idle;
    });
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: null,
      agentLoop: { handleMessage, waitForIdle },
    });

    const pending = delivery.deliverOrdinaryIcp(envelope());
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(waitForIdle).toHaveBeenCalledOnce();
    });

    releaseIdle();
    await expect(pending).resolves.toMatchObject({
      direction: 'parent_to_shard',
      content: 'Parent received the shard update.',
    });
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it('propagates screening failure and never injects unscreened content', async () => {
    const handleMessage = vi.fn(async (_message: SubstrateMessage) => response());
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: {
        screen: vi.fn(async () => {
          throw new Error('intake unavailable');
        }),
      } as never,
      agentLoop: { handleMessage, waitForIdle: vi.fn(async () => {}) },
    });

    await expect(delivery.deliverOrdinaryIcp(envelope()))
      .rejects.toThrow('intake unavailable');
    expect(handleMessage).not.toHaveBeenCalled();
  });
});
