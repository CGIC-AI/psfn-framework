import { describe, expect, it } from 'vitest';
import { buildShardLineageEnvelope } from './result-lineage.js';
import {
  buildShardMemoryOutputProvenanceTags,
  createShardTaggedOutput,
  isEmotionalOrRelationalShardMemory,
  resolveStagedShardMemoryOutputs,
} from './output-review.js';

const lineage = buildShardLineageEnvelope({
  kind: 'spawn',
  coreCompanionId: '11111111-1111-4111-8111-111111111111',
  shardId: 'shard-abc',
  shardChannelId: 'shard:shard-abc',
  sourceMessage: {
    id: 'shard-abc',
    channelId: 'shard:shard-abc',
    channelType: 'api',
    authorId: '11111111-1111-4111-8111-111111111111',
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

describe('isEmotionalOrRelationalShardMemory (bead 6arrc)', () => {
  it('flags every restricted memory type, not only emotional', () => {
    expect(isEmotionalOrRelationalShardMemory('emotional', [])).toBe(true);
    expect(isEmotionalOrRelationalShardMemory('relational', [])).toBe(true);
    expect(isEmotionalOrRelationalShardMemory('boundary', [])).toBe(true);
  });

  it('flags relational and boundary/consent tag hints', () => {
    expect(isEmotionalOrRelationalShardMemory('semantic', ['partner'])).toBe(true);
    expect(isEmotionalOrRelationalShardMemory('semantic', ['boundary_note'])).toBe(true);
    expect(isEmotionalOrRelationalShardMemory('procedural', ['consent'])).toBe(true);
  });

  it('flags restricted lived-history content hints', () => {
    expect(isEmotionalOrRelationalShardMemory('semantic', [], 'from her childhood in Ohio')).toBe(true);
    expect(isEmotionalOrRelationalShardMemory('semantic', [], 'a note about the grief he carries')).toBe(true);
  });

  it('leaves neutral memories unflagged', () => {
    expect(isEmotionalOrRelationalShardMemory('semantic', ['archive'])).toBe(false);
    expect(isEmotionalOrRelationalShardMemory('procedural', ['workflow'], 'deploy steps')).toBe(false);
  });

  it('stamps the interpretive provenance tag for a boundary type with no tags', () => {
    expect(buildShardMemoryOutputProvenanceTags('boundary', [], undefined, 'never bring up X'))
      .toContain('interpretive:emotional_or_relational');
    // Content hint alone (neutral type/tags) still stamps it.
    expect(buildShardMemoryOutputProvenanceTags('semantic', [], undefined, 'her childhood home'))
      .toContain('interpretive:emotional_or_relational');
    // A genuinely neutral memory is not stamped.
    expect(buildShardMemoryOutputProvenanceTags('semantic', ['archive'], undefined, 'deploy steps'))
      .not.toContain('interpretive:emotional_or_relational');
  });
});
