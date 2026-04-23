import { describe, expect, it } from 'vitest';
import { buildShardLineageEnvelope } from './result-lineage.js';
import {
  createShardTaggedOutput,
  resolveStagedShardMemoryOutputs,
} from './output-review.js';

const lineage = buildShardLineageEnvelope({
  kind: 'spawn',
  coreCompanionId: 'companion-test',
  shardId: 'shard-abc',
  shardChannelId: 'shard:shard-abc',
  sourceMessage: {
    id: 'shard-abc',
    channelId: 'shard:shard-abc',
    channelType: 'api',
    authorId: 'companion-test',
    authorName: 'Companion',
    timestamp: new Date('2026-04-23T12:00:00.000Z'),
  },
});

describe('output review staging', () => {
  it('creates pending tagged outputs with lineage and provenance', () => {
    const output = createShardTaggedOutput(
      {
        channelId: 'shard:shard-abc',
        task: 'quarantine import',
        lineage,
      },
      'l2_memory',
      'Imported shard memory 1 from backup (semantic)',
      'Imported memory contents',
      'memory_import_batch',
      Date.now(),
      180,
      {
        sourceToolName: 'memory_import_batch',
        toolCallId: 'import-call-1',
        provenanceTags: ['memory_type:semantic', 'memory_tag:archive'],
      },
    );

    expect(output.reviewState).toBe('pending');
    expect(output.reviewRequired).toBe(true);
    expect(output.blockedCorePromotion).toBe(true);
    expect(output.provenance).toEqual(expect.objectContaining({
      shardId: lineage.shardId,
      channelId: 'shard:shard-abc',
      source: 'memory_import_batch',
      sourceToolName: 'memory_import_batch',
      toolCallId: 'import-call-1',
      lineage,
    }));
    expect(output.provenance.tags).toEqual(expect.arrayContaining([
      'fold_back',
      'tagged_output_kind:l2_memory',
      'tagged_output_source:memory_import_batch',
      'memory_type:semantic',
      'memory_tag:archive',
    ]));
  });

  it('resolves staged shard memory imports as pending fold review outputs', () => {
    const outputs = resolveStagedShardMemoryOutputs(
      {
        channelId: 'shard:shard-abc',
        task: 'quarantine import',
        lineage,
      },
      'memory_import_batch',
      'import-call-2',
      {
        records: [
          {
            text: 'Imported fact',
            type: 'semantic',
            tags: 'Archive, Identity',
            sensitivity: 'personal',
          },
        ],
        source: 'backup',
      },
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual(expect.objectContaining({
      label: 'Imported shard memory 1 from backup (semantic)',
      source: 'memory_import_batch',
      reviewState: 'pending',
      blockedCorePromotion: true,
      provenance: expect.objectContaining({
        source: 'memory_import_batch',
        sourceToolName: 'memory_import_batch',
        toolCallId: 'import-call-2',
        lineage,
      }),
    }));
    expect(outputs[0].provenance.tags).toEqual(expect.arrayContaining([
      'memory_type:semantic',
      'sensitivity:personal',
      'memory_tag:archive',
      'memory_tag:identity',
    ]));
  });
});
