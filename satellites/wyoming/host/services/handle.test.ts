import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../../../src/shared/contracts/runtime.js';
import type { WyomingFrame, WyomingTransportSession } from '../../protocol/index.js';
import { createWyomingHandleServiceAdapter } from './handle.js';

const TEST_COMPANION_ID = 'companion-test';

function createTransportSession(connectionId: string): WyomingTransportSession {
  return {
    id: connectionId,
    connectionId,
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };
}

describe('Wyoming handle service adapter', () => {
  it('maps transcript events to handleMessage with stable context ids', async () => {
    const handleMessage = vi.fn(async (message: SubstrateMessage) => ({
      content: `reply:${message.content}`,
      channelId: message.channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 3,
      },
    }));

    const adapter = createWyomingHandleServiceAdapter({
      handleMessage,
      companionId: TEST_COMPANION_ID,
    });
    const transportSession = createTransportSession('conn-handle-1');

    const first = await adapter.handle({
      transportSession,
      sessionId: 'session-a',
      frame: {
        type: 'transcript',
        data: {
          session_id: 'session-a',
          text: 'hello there',
          site_id: 'home',
          satellite_id: 'sat-1',
          user_id: 'alice',
          user_name: 'Alice',
        },
      },
    }) as WyomingFrame;

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining<Partial<SubstrateMessage>>({
      channelType: 'api',
      channelId: 'api:wyoming:home:sat-1',
      authorId: 'wyoming-user:alice',
      authorName: 'Alice',
      isDirectMessage: true,
      content: 'hello there',
    }));
    expect(handleMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      routing: {
        source: 'wyoming',
        wyoming: expect.objectContaining({
          siteId: 'home',
          satelliteId: 'sat-1',
          presence: {
            companionId: TEST_COMPANION_ID,
            kind: 'satellite',
            siteId: 'home',
            satelliteId: 'sat-1',
          },
        }),
      },
    }));
    expect(first.type).toBe('handled');
    const contextId = first.data?.context_id as string;
    expect(contextId).toBeTruthy();

    const second = await adapter.handle({
      transportSession,
      sessionId: 'session-a',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-a',
          text: 'follow up',
        },
      },
    }) as WyomingFrame;

    expect(second.type).toBe('handled');
    expect(second.data?.context_id).toBe(contextId);
  });

  it('normalizes language/model aliases and fallback channel metadata', async () => {
    const handleMessage = vi.fn(async () => ({
      content: 'bonjour',
      channelId: 'api:wyoming:unknown:conn-handle-2',
      metadata: {
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 10,
      },
    }));

    const adapter = createWyomingHandleServiceAdapter({
      handleMessage,
      companionId: TEST_COMPANION_ID,
    });
    const response = await adapter.handle({
      transportSession: createTransportSession('conn-handle-2'),
      sessionId: 'session-b',
      frame: {
        type: 'text',
        data: {
          session_id: 'session-b',
          text: 'salut',
          lang: 'fr-CA',
          name: 'compat-model',
        },
      },
    }) as WyomingFrame;

    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining<Partial<SubstrateMessage>>({
      channelId: 'api:wyoming:unknown:conn-handle-2',
    }));
    expect(response).toEqual(expect.objectContaining({
      type: 'handled',
      data: expect.objectContaining({
        language: 'fr-CA',
        model: 'compat-model',
      }),
    }));
  });

  it('preserves canonical active embodiment presence in routing metadata', async () => {
    const handleMessage = vi.fn(async () => ({
      content: 'hello',
      channelId: 'api:wyoming:home:display',
      metadata: {
        model: 'model-x',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
    }));

    const adapter = createWyomingHandleServiceAdapter({
      handleMessage,
      companionId: TEST_COMPANION_ID,
    });
    await adapter.handle({
      transportSession: createTransportSession('conn-handle-4'),
      sessionId: 'session-d',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-d',
          text: 'hey',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'display',
            satellite_id: 'kitchen',
          },
        },
      },
    });

    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining<Partial<SubstrateMessage>>({
      routing: {
        source: 'wyoming',
        wyoming: expect.objectContaining({
          presence: expect.objectContaining({
            companionId: TEST_COMPANION_ID,
            kind: 'embodiment',
            embodimentId: 'display',
            satelliteId: 'kitchen',
            isPrimary: true,
          }),
        }),
      },
    }));
  });

  it('rejects conflicting active emanation metadata', async () => {
    const adapter = createWyomingHandleServiceAdapter({
      handleMessage: vi.fn(),
      companionId: TEST_COMPANION_ID,
    });

    const response = await adapter.handle({
      transportSession: createTransportSession('conn-handle-5'),
      sessionId: 'session-e',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-e',
          text: 'hello',
          presence: {
            kind: 'emanation',
            emanation_id: 'voice-node',
            isPrimary: true,
          },
        },
      },
    }) as WyomingFrame;

    expect(response).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        code: 'invalid_request',
        message: expect.stringContaining('conflicting active emanation metadata'),
      }),
    }));
  });

  it('returns invalid_request when text payload is missing', async () => {
    const adapter = createWyomingHandleServiceAdapter({
      handleMessage: vi.fn(),
      companionId: TEST_COMPANION_ID,
    });

    const response = await adapter.handle({
      transportSession: createTransportSession('conn-handle-3'),
      sessionId: 'session-c',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-c',
        },
      },
    }) as WyomingFrame;

    expect(response).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        code: 'invalid_request',
        service: 'handle',
      }),
    }));
  });

  it('rejects a new primary embodiment until an explicit handoff is provided', async () => {
    const handleMessage = vi.fn(async (message: SubstrateMessage) => ({
      content: `reply:${message.content}`,
      channelId: message.channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 3,
      },
    }));
    const adapter = createWyomingHandleServiceAdapter({
      handleMessage,
      companionId: TEST_COMPANION_ID,
    });

    await adapter.handle({
      transportSession: createTransportSession('conn-handle-6a'),
      sessionId: 'session-f',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-f',
          text: 'first embodiment',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'display',
            satellite_id: 'kitchen',
            companion_id: TEST_COMPANION_ID,
          },
        },
      },
    });

    const response = await adapter.handle({
      transportSession: createTransportSession('conn-handle-6b'),
      sessionId: 'session-g',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-g',
          text: 'second embodiment',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'speaker',
            satellite_id: 'office',
            companion_id: TEST_COMPANION_ID,
          },
        },
      },
    }) as WyomingFrame;

    expect(response).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        code: 'invalid_request',
        message: 'primary embodiment handoff required: display -> speaker',
      }),
    }));
  });

  it('accepts explicit embodiment handoff and clears primary state on session close', async () => {
    const handleMessage = vi.fn(async (message: SubstrateMessage) => ({
      content: `reply:${message.content}`,
      channelId: message.channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 3,
      },
    }));
    const adapter = createWyomingHandleServiceAdapter({
      handleMessage,
      companionId: TEST_COMPANION_ID,
    });

    await adapter.handle({
      transportSession: createTransportSession('conn-handle-7a'),
      sessionId: 'session-h',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-h',
          text: 'display embodied',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'display',
            satellite_id: 'kitchen',
            companion_id: TEST_COMPANION_ID,
          },
        },
      },
    });

    await adapter.handle({
      transportSession: createTransportSession('conn-handle-7b'),
      sessionId: 'session-i',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-i',
          text: 'speaker embodied',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'speaker',
            satellite_id: 'office',
            companion_id: TEST_COMPANION_ID,
          },
          presence_handoff: true,
          handoff_from_embodiment_id: 'display',
        },
      },
    });

    expect(handleMessage).toHaveBeenLastCalledWith(expect.objectContaining<Partial<SubstrateMessage>>({
      routing: {
        source: 'wyoming',
        wyoming: expect.objectContaining({
          presence: expect.objectContaining({
            kind: 'embodiment',
            embodimentId: 'speaker',
            satelliteId: 'office',
            isPrimary: true,
          }),
        }),
      },
    }));

    adapter.onSessionClosed?.({
      connectionId: 'conn-handle-7b',
      sessionId: 'session-i',
      reason: 'disconnect',
    });

    const reopened = await adapter.handle({
      transportSession: createTransportSession('conn-handle-7c'),
      sessionId: 'session-j',
      frame: {
        type: 'handle',
        data: {
          session_id: 'session-j',
          text: 'new embodiment after close',
          presence: {
            kind: 'embodiment',
            embodiment_id: 'projector',
            satellite_id: 'studio',
            companion_id: TEST_COMPANION_ID,
          },
        },
      },
    }) as WyomingFrame;

    expect(reopened.type).toBe('handled');
    expect(handleMessage).toHaveBeenLastCalledWith(expect.objectContaining<Partial<SubstrateMessage>>({
      routing: {
        source: 'wyoming',
        wyoming: expect.objectContaining({
          presence: expect.objectContaining({
            kind: 'embodiment',
            embodimentId: 'projector',
            satelliteId: 'studio',
            isPrimary: true,
          }),
        }),
      },
    }));
  });
});
