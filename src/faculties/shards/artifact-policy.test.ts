import { describe, expect, it } from 'vitest';
import { buildShardLineageEnvelope } from './result-lineage.js';
import { createArtifactReturnPort } from './artifact-return-port.js';
import { buildShardReturnedArtifacts } from './artifact-policy.js';

describe('buildShardReturnedArtifacts', () => {
  const TEST_COMPANION_ID = 'companion-test';
  const lineage = buildShardLineageEnvelope({
    kind: 'spawn',
    coreCompanionId: TEST_COMPANION_ID,
    shardId: 'shard-42',
    shardChannelId: 'shard:shard-42',
    sourceMessage: {
      id: 'shard-42',
      channelId: 'shard:shard-42',
      channelType: 'api',
      authorId: TEST_COMPANION_ID,
      authorName: 'ShardManager',
      timestamp: new Date('2026-03-28T12:00:00.000Z'),
    },
  });

  it('classifies image attachments as review-required returned artifacts with provenance', () => {
    const artifacts = buildShardReturnedArtifacts({
      lineage,
      turnIndex: 2,
      turnMessageId: 'turn-42',
      attachments: [{
        url: 'https://images.example.test/fold-back.png',
        contentType: 'image/png',
        name: 'fold-back.png',
        localPath: '/tmp/fold-back.png',
      }],
    });

    expect(artifacts).toEqual([{
      schemaVersion: 1,
      kind: 'attachment',
      mergePolicy: 'review_required',
      artifactId: 'artifact-shard-42-2-1',
      url: 'https://images.example.test/fold-back.png',
      contentType: 'image/png',
      name: 'fold-back.png',
      localPath: '/tmp/fold-back.png',
      provenance: {
        lineage,
        turnIndex: 2,
        turnMessageId: 'turn-42',
      },
    }]);
  });

  it('fails closed on ambiguous or invalid attachment returns', () => {
    expect(() => buildShardReturnedArtifacts({
      lineage,
      turnIndex: 1,
      turnMessageId: 'turn-42',
      attachments: [{
        url: 'https://images.example.test/fold-back.json',
        contentType: 'application/json',
        name: 'fold-back.json',
      }],
    })).toThrow('ambiguous');

    expect(() => buildShardReturnedArtifacts({
      lineage,
      turnIndex: 1,
      turnMessageId: 'turn-42',
      attachments: [{
        url: 'not-a-url',
        contentType: 'image/png',
        name: 'fold-back.png',
      }],
    })).toThrow('valid URL');
  });

  it('collects artifact returns through the artifact return port', () => {
    const artifactReturnPort = createArtifactReturnPort();

    expect(artifactReturnPort.collectArtifactReturn({
      lineage,
      turnIndex: 2,
      turnMessageId: 'turn-42',
      attachments: [{
        url: 'https://images.example.test/fold-back.png',
        contentType: 'image/png',
        name: 'fold-back.png',
      }],
    })).toEqual({
      mergePolicy: 'review_required',
      artifacts: [expect.objectContaining({
        artifactId: 'artifact-shard-42-2-1',
        url: 'https://images.example.test/fold-back.png',
      })],
    });
  });
});
