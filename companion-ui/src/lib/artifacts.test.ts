import { describe, expect, it } from 'vitest';
import {
  ARTIFACTS_UNSUPPORTED_REASON,
  deriveArtifactShelfState,
  readArtifactPreview,
} from './artifacts.js';
import { createInitialHubStreamState } from './stream/hub-stream.js';

describe('artifact shelf fail-closed state', () => {
  it('reports unsupported artifact capability when hub protocol has no artifact messages', () => {
    expect(deriveArtifactShelfState(createInitialHubStreamState())).toEqual({
      capability: 'unsupported',
      items: [],
      blockedReason: ARTIFACTS_UNSUPPORTED_REASON,
    });
  });

  it('blocks artifact preview reads without a scoped hub artifact path', () => {
    expect(() => readArtifactPreview()).toThrow(ARTIFACTS_UNSUPPORTED_REASON);
  });
});
