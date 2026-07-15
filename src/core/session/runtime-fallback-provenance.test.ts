import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithRuntimeFallbackProvenance,
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
});
