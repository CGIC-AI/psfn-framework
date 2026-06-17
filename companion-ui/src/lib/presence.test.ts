import { describe, expect, it } from 'vitest';
import { createInitialHubStreamState, type HubStreamState } from './stream/hub-stream.js';
import { derivePresenceState, formatElapsed } from './presence.js';

describe('presence reducer', () => {
  it('reports ready listening state without assuming active emanation', () => {
    const presence = derivePresenceState({
      ...createInitialHubStreamState('2026-06-17T00:00:00.000Z'),
      connection: 'ready',
      phase: 'listening',
    }, Date.parse('2026-06-17T00:00:04.000Z'));

    expect(presence).toMatchObject({
      connection: 'connected',
      phase: 'listening',
      operationClass: 'idle',
      inputExpected: 'yes',
      emanation: 'unreported',
      satelliteId: null,
    });
  });

  it('reports assistant response elapsed time and satellite identity when supplied by the hub', () => {
    const state = withSession({
      ...createInitialHubStreamState('2026-06-17T00:00:00.000Z'),
      connection: 'ready',
      phase: 'responding',
      liveAssistant: {
        id: 'live',
        role: 'assistant',
        content: 'working',
        live: true,
        final: false,
        sequence: 3,
        receivedAt: '2026-06-17T00:00:10.000Z',
        sessionId: 'session-1',
        channelId: 'satellite.endpoint:session-1',
      },
    });

    const presence = derivePresenceState(state, Date.parse('2026-06-17T00:00:15.000Z'));

    expect(presence).toMatchObject({
      connection: 'connected',
      phase: 'responding',
      operationClass: 'assistant_response',
      inputExpected: 'no',
      elapsedMs: 5000,
      silence: 'none',
      emanation: 'reported',
      satelliteId: 'phone',
    });
  });

  it('distinguishes connected silence from failure', () => {
    const state = withSession({
      ...createInitialHubStreamState('2026-06-17T00:00:00.000Z'),
      connection: 'ready',
      phase: 'responding',
      liveAssistant: {
        id: 'live',
        role: 'assistant',
        content: 'first token',
        live: true,
        final: false,
        sequence: 1,
        receivedAt: '2026-06-17T00:00:00.000Z',
      },
    });

    const presence = derivePresenceState(state, Date.parse('2026-06-17T00:00:20.000Z'));

    expect(presence.connection).toBe('connected');
    expect(presence.silence).toBe('connected_no_recent_delta');
    expect(presence.failed).toBe(false);
  });

  it('surfaces disconnect and failure honestly', () => {
    const disconnected = derivePresenceState({
      ...createInitialHubStreamState(),
      connection: 'disconnected',
      phase: 'responding',
    });

    expect(disconnected).toMatchObject({
      connection: 'disconnected',
      phase: 'offline',
      inputExpected: 'no',
      failed: false,
    });

    const failed = derivePresenceState({
      ...createInitialHubStreamState(),
      connection: 'failed',
      phase: 'failed',
      failure: {
        message: 'protocol violation',
        recoverable: false,
        at: '2026-06-17T00:00:00.000Z',
      },
    });

    expect(failed).toMatchObject({
      connection: 'failed',
      phase: 'failed',
      operationClass: 'failure',
      inputExpected: 'no',
      failed: true,
      failureMessage: 'protocol violation',
    });
  });

  it('does not expose reasoning or emotion fields', () => {
    const keys = Object.keys(derivePresenceState(createInitialHubStreamState())).join(' ');

    expect(keys).not.toMatch(/reasoning|thought|emotion|feeling|belief/i);
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});

function withSession(state: HubStreamState): HubStreamState {
  return {
    ...state,
    session: {
      deviceId: 'phone',
      deviceName: 'Phone',
      satelliteId: 'phone',
      satelliteName: 'Phone',
      sessionId: 'session-1',
      channelId: 'satellite.endpoint:session-1',
    },
  };
}
