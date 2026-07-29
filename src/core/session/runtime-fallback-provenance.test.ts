import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithRuntimeFallbackProvenance,
  isRuntimeAuthoredFallbackSessionEntry,
  parseSessionRuntimeFallbackProvenance,
} from './runtime-fallback-provenance.js';

describe('session runtime fallback provenance', () => {
  it('preserves existing metadata while adding explicit runtime authorship', () => {
    const metadata = buildSessionMetadataWithRuntimeFallbackProvenance(
      JSON.stringify({ emotionState: { confidence: 0.8 } }),
      {
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      },
    );

    expect(JSON.parse(metadata)).toEqual({
      emotionState: { confidence: 0.8 },
      runtimeFallbackProvenance: {
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      },
    });
    expect(parseSessionRuntimeFallbackProvenance(metadata)).toEqual({
      schemaVersion: 1,
      authoredBy: 'runtime',
      model: 'runtime-fallback',
      strategy: 'runtime_nonfabricating_notice',
    });
  });

  it('keeps ordinary assistant metadata compatible and rejects fabricated provenance values', () => {
    expect(parseSessionRuntimeFallbackProvenance(JSON.stringify({ turn: { schemaVersion: 1 } }))).toBeNull();
    expect(() => parseSessionRuntimeFallbackProvenance(JSON.stringify({
      runtimeFallbackProvenance: {
        schemaVersion: 1,
        authoredBy: 'companion',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      },
    }))).toThrow('metadata.runtimeFallbackProvenance.authoredBy must be "runtime"');
  });

  it('classifies entries persisted through the real metadata builder as runtime-authored', () => {
    const metadata = buildSessionMetadataWithRuntimeFallbackProvenance(undefined, {
      schemaVersion: 1,
      authoredBy: 'runtime',
      model: 'runtime-fallback',
      strategy: 'runtime_nonfabricating_notice',
    });

    expect(isRuntimeAuthoredFallbackSessionEntry({ metadata })).toBe(true);
  });

  it('does not classify ordinary or unreadable entries as runtime-authored', () => {
    expect(isRuntimeAuthoredFallbackSessionEntry({})).toBe(false);
    expect(isRuntimeAuthoredFallbackSessionEntry({ metadata: undefined })).toBe(false);
    expect(isRuntimeAuthoredFallbackSessionEntry({
      metadata: JSON.stringify({ emotionState: { confidence: 0.8 } }),
    })).toBe(false);
    expect(isRuntimeAuthoredFallbackSessionEntry({
      metadata: JSON.stringify({
        sessionLane: { schemaVersion: 1, kind: 'internal' },
      }),
    })).toBe(false);
    expect(isRuntimeAuthoredFallbackSessionEntry({ metadata: '{not json' })).toBe(false);
    expect(isRuntimeAuthoredFallbackSessionEntry({ metadata: JSON.stringify(['array']) })).toBe(false);
  });

  it('fails closed on a marker with a malformed value: still runtime-authored', () => {
    expect(isRuntimeAuthoredFallbackSessionEntry({
      metadata: JSON.stringify({ runtimeFallbackProvenance: { schemaVersion: 999 } }),
    })).toBe(true);
    expect(isRuntimeAuthoredFallbackSessionEntry({
      metadata: JSON.stringify({ runtimeFallbackProvenance: null }),
    })).toBe(true);
  });
});
