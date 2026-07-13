import { describe, expect, it } from 'vitest';
import {
  createCompanionId,
  createGatewayRoutingEnvelope,
  createShardLineage,
  deriveShardRoutingEnvelope,
  parseGatewayRoutingEnvelope,
} from './envelope.js';

const COMPANION_ALPHA = createCompanionId('companion-alpha');

describe('routing envelope', () => {
  it('derives shard companion ids from the tenancy companion id and shard id', () => {
    const lineage = createShardLineage({
      companionId: COMPANION_ALPHA,
      shardId: 'shard-42',
    });

    expect(lineage).toEqual({
      coreCompanionId: 'companion-alpha',
      shardCompanionId: 'companion-alpha/shards/shard-42',
      shardId: 'shard-42',
      creationMode: 'fresh',
    });
  });

  it('keeps shard lineage separate from subagent addressing inside the gateway envelope', () => {
    const envelope = createGatewayRoutingEnvelope({
      companionId: COMPANION_ALPHA,
      shard: createShardLineage({
        companionId: COMPANION_ALPHA,
        shardId: 'shard-99',
        parentShardId: 'shard-root',
      }),
      subagentAddress: {
        executionPort: 'subagent',
        workerId: 'worker-12',
        lane: 'subagent',
      },
    });

    expect(envelope).toEqual({
      schemaVersion: 1,
      companionId: 'companion-alpha',
      shard: {
        coreCompanionId: 'companion-alpha',
        shardCompanionId: 'companion-alpha/shards/shard-99',
        shardId: 'shard-99',
        creationMode: 'fresh',
        parentShardId: 'shard-root',
      },
      subagentAddress: {
        executionPort: 'subagent',
        workerId: 'worker-12',
        lane: 'subagent',
      },
    });
  });

  it('derives nested shard routing envelopes without changing the tenancy boundary', () => {
    const envelope = deriveShardRoutingEnvelope({
      companionId: COMPANION_ALPHA,
      shardId: 'shard-child',
      parentShardId: 'shard-parent',
    });

    expect(envelope.companionId).toBe('companion-alpha');
    expect(envelope.shard).toEqual({
      coreCompanionId: 'companion-alpha',
      shardCompanionId: 'companion-alpha/shards/shard-child',
      shardId: 'shard-child',
      creationMode: 'fresh',
      parentShardId: 'shard-parent',
    });
  });

  it('marks forked shard lineage explicitly without collapsing subagent semantics into shard routing', () => {
    const envelope = deriveShardRoutingEnvelope({
      companionId: COMPANION_ALPHA,
      shardId: 'shard-forked',
      creationMode: 'forked',
      parentShardId: 'shard-parent',
      subagentAddress: {
        executionPort: 'subagent',
        workerId: 'worker-12',
        lane: 'subagent',
      },
    });

    expect(envelope.shard).toEqual({
      coreCompanionId: 'companion-alpha',
      shardCompanionId: 'companion-alpha/shards/shard-forked',
      shardId: 'shard-forked',
      creationMode: 'forked',
      parentShardId: 'shard-parent',
    });
    expect(envelope.subagentAddress).toEqual({
      executionPort: 'subagent',
      workerId: 'worker-12',
      lane: 'subagent',
    });
  });

  it('rebrands a valid envelope decoded from an untyped transport payload', () => {
    const parsed = parseGatewayRoutingEnvelope({
      schemaVersion: 1,
      companionId: 'companion-alpha',
      shard: {
        coreCompanionId: 'companion-alpha',
        shardCompanionId: 'companion-alpha/shards/shard-42',
        shardId: 'shard-42',
        creationMode: 'fresh',
      },
    }, 'message.routing.gateway');

    expect(parsed).toEqual({
      schemaVersion: 1,
      companionId: 'companion-alpha',
      shard: {
        coreCompanionId: 'companion-alpha',
        shardCompanionId: 'companion-alpha/shards/shard-42',
        shardId: 'shard-42',
        creationMode: 'fresh',
      },
    });
  });

  it('rejects malformed companion and shard claims decoded from transport payloads', () => {
    expect(() => parseGatewayRoutingEnvelope({
      schemaVersion: 1,
      companionId: 'companion:alpha',
    }, 'message.routing.gateway')).toThrow('message.routing.gateway.companionId');

    expect(() => parseGatewayRoutingEnvelope({
      schemaVersion: 1,
      companionId: 'companion-alpha',
      shard: {
        coreCompanionId: 'companion-alpha',
        shardCompanionId: 'companion-beta/shards/shard-42',
        shardId: 'shard-42',
        creationMode: 'fresh',
      },
    }, 'message.routing.gateway')).toThrow(
      'message.routing.gateway.shard.shardCompanionId must match coreCompanionId and shardId',
    );
  });
});
