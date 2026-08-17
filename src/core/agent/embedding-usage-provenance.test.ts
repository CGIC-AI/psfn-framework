import { describe, expect, it } from 'vitest';
import {
  createContentFreeEmbeddingWorkloadId,
  embeddingUsageProvenanceFromRequestContext,
} from './embedding-usage-provenance.js';

describe('createContentFreeEmbeddingWorkloadId', () => {
  it('returns a stable bounded identity without retaining source content', () => {
    const sourceIdentity = 'https://private.example/wiki/My revealing title';
    const workloadId = createContentFreeEmbeddingWorkloadId('wiki-projection', sourceIdentity);

    expect(workloadId).toMatch(/^wiki-projection:[a-f0-9]{64}$/);
    expect(workloadId).not.toContain(sourceIdentity);
    expect(createContentFreeEmbeddingWorkloadId('wiki-projection', sourceIdentity)).toBe(workloadId);
  });
});

describe('embeddingUsageProvenanceFromRequestContext', () => {
  it('leaves a context-free health probe deliberately unattributed', () => {
    expect(embeddingUsageProvenanceFromRequestContext(undefined)).toBeUndefined();
  });

  it('preserves a durable background workload and its runtime class', () => {
    expect(embeddingUsageProvenanceFromRequestContext({
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      channelId: 'discord:room-1',
      callType: 'background',
      purpose: 'extraction',
      originType: 'background',
      originStage: 'extraction',
      workloadType: 'background_work',
      workloadId: 'extraction:turn-1',
    })).toEqual({
      callType: 'background',
      purpose: 'extraction',
      originType: 'background',
      originStage: 'extraction',
      service: 'memory',
      process: 'extraction',
      runtimeLaneClass: 'background_continuation',
      workloadType: 'background_work',
      workloadId: 'extraction:turn-1',
    });
  });

  it('bounds companion-private attribution without retaining request identity', () => {
    const provenance = embeddingUsageProvenanceFromRequestContext({
      requestId: 'private-request',
      callType: 'background',
      purpose: 'companion_private.background',
      originStage: 'introspection.blinded',
      service: 'introspection',
      process: 'blinded-audit',
      telemetryVisibility: 'companion_private',
      workloadType: 'private-audit',
      workloadId: 'private-workload',
    });

    expect(provenance).toEqual({
      callType: 'background',
      purpose: 'companion_private.background',
      originType: 'background',
      originStage: 'companion_private.background',
      service: 'companion-private',
      process: 'embedding',
      runtimeLaneClass: 'background_continuation',
      workloadType: 'companion_private_embedding',
      workloadId: 'companion-private:embedding',
    });
    expect(JSON.stringify(provenance)).not.toContain('private-request');
    expect(JSON.stringify(provenance)).not.toContain('private-workload');
    expect(JSON.stringify(provenance)).not.toContain('introspection.blinded');
  });
});
