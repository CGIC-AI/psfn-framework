import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArtifactReturnPort } from './artifact-return-port.js';
import { ShardFoldReviewController } from './fold-review.js';
import { resolveStagedShardMemoryOutputs } from './output-review.js';
import type { ShardResultLineageEnvelope } from './result-lineage.js';

function buildLineage(shardId: string): ShardResultLineageEnvelope {
  return {
    schemaVersion: 2,
    kind: 'spawn',
    coreCompanionId: '11111111-1111-4111-8111-111111111111',
    shardCompanionId: `11111111-1111-4111-8111-111111111111::${shardId}`,
    shardId,
    shardChannelId: `shard:${shardId}`,
    companionProvenance: {
      parentCompanionId: '11111111-1111-4111-8111-111111111111',
      shardCompanionId: `11111111-1111-4111-8111-111111111111::${shardId}`,
    },
    sourceMessage: {
      id: shardId,
      channelId: `shard:${shardId}`,
      channelType: 'api',
      authorId: '11111111-1111-4111-8111-111111111111',
      authorName: 'Companion',
      timestampMs: 1_710_000_000_000,
      isDirectMessage: false,
    },
  };
}

describe('ShardFoldReviewController', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('persists merged shard memory and artifact reviews across controller reloads', async () => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-fold-review-'));
    const storePath = join(dir, 'state', 'shard-fold-reviews.json');
    const shardId = 'shard-review-1';
    const lineage = buildLineage(shardId);
    const controller = new ShardFoldReviewController(storePath);
    const stagedOutputs = resolveStagedShardMemoryOutputs(
      { channelId: 'api:review', task: 'inspect fold review', lineage },
      'memory_import_batch',
      'import-call-1',
      {
        records: [{
          text: 'Partner feels anxious about the release.',
          type: 'emotional',
          tags: 'relationship,partner',
          sensitivity: 'intimate',
        }],
        source: 'backup',
      },
    );
    const artifactReturn = createArtifactReturnPort().collectArtifactReturn({
      lineage,
      turnIndex: 1,
      turnMessageId: shardId,
      attachments: [{
        url: 'https://images.example.test/fold-review.png',
        contentType: 'image/png',
        name: 'fold-review.png',
      }],
    });

    expect(stagedOutputs).toHaveLength(1);
    expect(artifactReturn).not.toBeNull();
    await controller.recordPendingMemoryCandidates({
      shardId,
      channelId: 'api:review',
      task: 'inspect fold review',
      lineage,
      outputs: stagedOutputs,
    });
    await controller.recordArtifactReturn({
      shardId,
      channelId: 'api:review',
      task: 'inspect fold review',
      lineage,
      artifactReturn: artifactReturn!,
    });

    const reloaded = new ShardFoldReviewController(storePath);
    const review = await reloaded.getFoldReview(shardId);
    expect(review).toMatchObject({
      shardId,
      reviewState: 'pending',
      validationPath: `/api/admin/shards/${shardId}`,
      memoryItems: [
        expect.objectContaining({
          reviewState: 'pending',
          candidate: expect.objectContaining({
            type: 'emotional',
            sensitivity: 'intimate',
          }),
        }),
      ],
      artifactItems: [
        expect.objectContaining({
          reviewState: 'pending',
          artifact: expect.objectContaining({
            artifactId: `artifact-${shardId}-1-1`,
          }),
        }),
      ],
    });
    expect(review?.blockingReasons).toEqual(expect.arrayContaining([
      'artifact_output_pending_merge_review',
      'staged_shard_memory_pending_merge_review',
      'emotional_or_relational_interpretation_requires_core_review',
    ]));
    expect(review?.visibilitySignals).toMatchObject({
      emotionalOrRelational: true,
      emotionalOrRelationalOutputIds: [stagedOutputs[0].outputId],
    });
  });

  it('fails closed when approval is requested without memory promotion dependencies', async () => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-fold-review-'));
    const storePath = join(dir, 'state', 'shard-fold-reviews.json');
    const shardId = 'shard-review-2';
    const lineage = buildLineage(shardId);
    const controller = new ShardFoldReviewController(storePath);
    const stagedOutputs = resolveStagedShardMemoryOutputs(
      { channelId: 'api:review', task: 'approve later', lineage },
      'memory_import_batch',
      'import-call-2',
      {
        records: [{
          text: 'Remember the migration checklist.',
          type: 'procedural',
        }],
      },
    );

    await controller.recordPendingMemoryCandidates({
      shardId,
      channelId: 'api:review',
      task: 'approve later',
      lineage,
      outputs: stagedOutputs,
    });

    const review = await controller.resolveFoldReview({
      shardId,
      decision: 'approve',
      actor: 'operator:test',
    });

    expect(review).toMatchObject({
      reviewState: 'blocked',
      lastReviewedBy: 'operator:test',
      lastReviewDecision: 'approve',
    });
    expect(review?.memoryItems[0]).toMatchObject({
      reviewState: 'blocked',
      blockingReasons: expect.arrayContaining([
        'fold_review_memory_promotion_unavailable',
      ]),
    });
  });

  it('preserves structured subagent origin when an approved staged candidate reaches the memory writer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-fold-review-'));
    const storePath = join(dir, 'state', 'shard-fold-reviews.json');
    const subagentId = 'subagent-review-1';
    const lineage = buildLineage(subagentId);
    const write = vi.fn(async () => ({
      action: 'created' as const,
      memory: { id: 'memory-from-subagent' },
    }));
    const controller = new ShardFoldReviewController(storePath, { write } as never);
    const stagedOutputs = resolveStagedShardMemoryOutputs(
      { channelId: `subagent:${subagentId}`, task: 'summarize childhood document', lineage },
      'memory',
      'memory-call-subagent-stage',
      {
        action: 'write',
        text: "The document recounts the operator's childhood.",
        type: 'emotional',
      },
    );
    Object.assign(stagedOutputs[0]!.provenance, {
      workerKind: 'subagent',
      subagentId,
    });

    await controller.recordPendingMemoryCandidates({
      shardId: subagentId,
      channelId: `subagent:${subagentId}`,
      task: 'summarize childhood document',
      lineage,
      outputs: stagedOutputs,
    });
    await controller.resolveFoldReview({
      shardId: subagentId,
      decision: 'approve',
      actor: 'operator:test',
    });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: `source:subagent:${subagentId}|tool:memory|invocation:memory-call-subagent-stage|fold_review:approved`,
      sourceType: 'subagent',
      provenance: expect.objectContaining({
        channelId: `subagent:${subagentId}`,
        subagentId,
        actor: 'subagent',
        reason: 'subagent_fold_review_approved',
      }),
      provenanceRefs: expect.arrayContaining([
        `subagent_output:${stagedOutputs[0]!.outputId}`,
        `subagent_lineage:${subagentId}`,
      ]),
    }));
  });
});
