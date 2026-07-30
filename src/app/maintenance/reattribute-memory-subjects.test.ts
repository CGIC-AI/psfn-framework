import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  parseArgs,
  parseContactMapping,
} from './reattribute-memory-subjects.js';
import {
  normalizeMemorySubjectContactMappings,
  reattributePostgresMemorySubjects,
} from '../../persistence/repair/memory-subject-reattribution.js';

describe('memory subject re-attribution maintenance CLI', () => {
  it('is dry-run by default and accepts repeated exact contact mappings', () => {
    expect(parseArgs([
      '--map', 'old-a=current',
      '--map', 'old-b=current',
      '--schema', 'companion_a',
      '--embedding-dims', '1536',
    ])).toMatchObject({
      apply: false,
      mappings: [
        { fromContactId: 'old-a', toContactId: 'current' },
        { fromContactId: 'old-b', toContactId: 'current' },
      ],
      schema: 'companion_a',
      embeddingDims: 1536,
    });
  });

  it('requires unambiguous mappings and rejects chained re-attribution', () => {
    expect(() => parseContactMapping('old=current=other')).toThrow(/must use/u);
    expect(() => normalizeMemorySubjectContactMappings([
      { fromContactId: 'old-a', toContactId: 'old-b' },
      { fromContactId: 'old-b', toContactId: 'current' },
    ])).toThrow(/Chained contact mappings/u);
    expect(() => normalizeMemorySubjectContactMappings([
      { fromContactId: 'same', toContactId: 'same' },
    ])).toThrow(/must differ/u);
  });

  it('rejects malformed numeric and unknown arguments', () => {
    expect(() => parseArgs([
      '--map', 'old=current',
      '--embedding-dims', '1536junk',
    ])).toThrow(/positive integer/u);
    expect(() => parseArgs(['--unexpected'])).toThrow(/Unknown argument/u);
  });

  it('requires callers to choose dry-run or apply explicitly', async () => {
    await expect(reattributePostgresMemorySubjects({} as Pool, {
      mappings: [{ fromContactId: 'old', toContactId: 'current' }],
      dryRun: undefined as never,
    })).rejects.toThrow(/dryRun must be explicitly true or false/u);
  });
});
