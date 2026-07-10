import { describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PREVIEW_NOT_PREVIEWABLE_REASON,
  ARTIFACTS_UNSUPPORTED_REASON,
  deriveArtifactShelfState,
  readArtifactPreview,
  type ArtifactPreviewTransport,
} from './artifacts.js';
import {
  createInitialHubStreamState,
  reduceHubStreamState,
  type HubStreamState,
} from './stream/hub-stream.js';

function ackedState(at = '2026-06-17T00:00:00.000Z'): HubStreamState {
  return reduceHubStreamState(createInitialHubStreamState(at), {
    type: 'hub.inbound',
    at,
    event: {
      message: {
        type: 'hello.ack',
        sessionId: 'session-1',
        channelId: 'channel-1',
        deviceId: 'device-1',
        deviceName: 'Device',
        satelliteId: 'satellite-1',
        satelliteName: 'Satellite',
        capabilities: {
          input: ['text'],
          output: ['text', 'artifact', 'tool_activity'],
          control: ['interrupt', 'approvals'],
          safety: ['confirmation_required'],
        },
      },
    },
  });
}

function withArtifact(
  state: HubStreamState,
  data: {
    id: string;
    label: string;
    mediaType: string;
    provenance: string;
    createdAt: string;
    previewable: boolean;
  },
  at = '2026-06-17T00:00:01.000Z',
): HubStreamState {
  return reduceHubStreamState(state, {
    type: 'hub.inbound',
    at,
    event: { message: { type: 'artifact.created', data } },
  });
}

const sampleArtifact = {
  id: 'art-1',
  label: 'Report',
  mediaType: 'image/png',
  provenance: 'tool:renderer',
  createdAt: '2026-06-17T00:00:01.000Z',
  previewable: true,
};

describe('artifact shelf fail-closed state', () => {
  it('reports unsupported when the hub has not acked the artifact capability', () => {
    expect(deriveArtifactShelfState(createInitialHubStreamState())).toEqual({
      capability: 'unsupported',
      items: [],
      blockedReason: ARTIFACTS_UNSUPPORTED_REASON,
    });
  });

  it('lists created artifacts once the capability is acked', () => {
    const state = withArtifact(ackedState(), sampleArtifact);
    const shelf = deriveArtifactShelfState(state);

    expect(shelf.capability).toBe('available');
    expect(shelf.items).toHaveLength(1);
    expect(shelf.items[0]).toMatchObject({ id: 'art-1', previewable: true, preview: { state: 'idle' } });
  });

  it('marks non-previewable artifacts as unavailable and refuses to fetch them', () => {
    const state = withArtifact(ackedState(), { ...sampleArtifact, id: 'art-2', previewable: false });
    const shelf = deriveArtifactShelfState(state);
    expect(shelf.items[0]?.preview.state).toBe('unavailable');

    const transport: ArtifactPreviewTransport = { requestArtifactPreview: vi.fn() };
    expect(() => readArtifactPreview(transport, state, 'art-2')).toThrow(
      ARTIFACT_PREVIEW_NOT_PREVIEWABLE_REASON,
    );
    expect(transport.requestArtifactPreview).not.toHaveBeenCalled();
  });

  it('blocks preview reads when the capability is not acked', () => {
    const transport: ArtifactPreviewTransport = { requestArtifactPreview: vi.fn() };
    const state = withArtifact(createInitialHubStreamState(), sampleArtifact);
    expect(() => readArtifactPreview(transport, state, 'art-1')).toThrow(ARTIFACTS_UNSUPPORTED_REASON);
    expect(transport.requestArtifactPreview).not.toHaveBeenCalled();
  });

  it('delegates a preview fetch for a previewable artifact', () => {
    const transport: ArtifactPreviewTransport = { requestArtifactPreview: vi.fn() };
    const state = withArtifact(ackedState(), sampleArtifact);
    readArtifactPreview(transport, state, 'art-1');
    expect(transport.requestArtifactPreview).toHaveBeenCalledWith('art-1');
  });
});

describe('artifact preview correlation', () => {
  function loading(state: HubStreamState, requestId: string, artifactId = 'art-1'): HubStreamState {
    return reduceHubStreamState(state, {
      type: 'artifact.preview.request',
      requestId,
      artifactId,
      at: '2026-06-17T00:00:02.000Z',
    });
  }

  it('resolves a preview result that correlates to the in-flight request', () => {
    let state = withArtifact(ackedState(), sampleArtifact);
    state = loading(state, 'req-1');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'artifact.preview.result',
          requestId: 'req-1',
          artifactId: 'art-1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    });

    expect(deriveArtifactShelfState(state).items[0]?.preview).toMatchObject({
      state: 'ready',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
    });
  });

  it('drops a stale result whose requestId no longer matches', () => {
    let state = withArtifact(ackedState(), sampleArtifact);
    state = loading(state, 'req-2');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'artifact.preview.result',
          requestId: 'req-1',
          artifactId: 'art-1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    });

    expect(deriveArtifactShelfState(state).items[0]?.preview.state).toBe('loading');
  });

  it('classifies a denial error into a denied preview state', () => {
    let state = withArtifact(ackedState(), sampleArtifact);
    state = loading(state, 'req-1');
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:03.000Z',
      event: {
        message: {
          type: 'artifact.preview.error',
          requestId: 'req-1',
          artifactId: 'art-1',
          message: 'Access denied for scoped artifact',
        },
      },
    });

    expect(deriveArtifactShelfState(state).items[0]?.preview.state).toBe('denied');
  });

  it('ages an unanswered preview request out to an error on timeout', () => {
    let state = withArtifact(ackedState(), sampleArtifact);
    state = loading(state, 'req-1');
    state = reduceHubStreamState(state, {
      type: 'artifact.preview.timeout',
      requestId: 'req-1',
      artifactId: 'art-1',
      at: '2026-06-17T00:00:20.000Z',
    });

    expect(deriveArtifactShelfState(state).items[0]?.preview).toMatchObject({
      state: 'error',
      message: 'Preview timed out',
    });
  });
});
