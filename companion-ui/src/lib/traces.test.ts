import { describe, expect, it } from 'vitest';
import { createInitialHubStreamState, reduceHubStreamState } from './stream/hub-stream.js';
import { deriveOperationalTraces } from './traces.js';

describe('operational traces', () => {
  it('uses session participant names in visible message and interrupt summaries', () => {
    let state = reduceHubStreamState(createInitialHubStreamState(), {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:00.000Z',
      event: {
        message: {
          type: 'session.ready',
          sessionId: 'session-1',
          channelId: 'channel-1',
          deviceId: 'device-1',
          deviceName: 'Device',
          satelliteId: 'satellite-1',
          audioFormat: 'pcm16',
          identity: {
            source: 'framework',
            companion: { id: 'companion-1', name: 'Purrsephone' },
            user: { id: 'contact-1', name: 'Ada' },
          },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'message',
          data: { role: 'assistant', content: 'hello', final: true },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:02.000Z',
      event: {
        message: {
          type: 'assistant.interrupted',
          sessionId: 'session-1',
        },
      },
    });

    const traces = deriveOperationalTraces(state);

    expect(traces[1]).toMatchObject({
      operationClass: 'assistant_message',
      summary: 'Purrsephone message',
      metadata: { role: 'assistant' },
    });
    expect(traces[2]).toMatchObject({
      operationClass: 'assistant_interrupt',
      summary: 'Purrsephone interrupted',
    });
  });

  it('redacts message content while preserving operational metadata', () => {
    const secretText = 'do not show this raw text';
    const state = reduceHubStreamState(createInitialHubStreamState(), {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:00.000Z',
      event: {
        message: {
          type: 'message',
          data: { role: 'assistant', content: secretText, live: true },
        },
      },
    });

    const traces = deriveOperationalTraces(state);

    expect(JSON.stringify(traces)).not.toContain(secretText);
    expect(traces[0]).toMatchObject({
      operationClass: 'assistant_message',
      status: 'active',
      metadata: {
        role: 'assistant',
        live: true,
        final: false,
        contentChars: secretText.length,
      },
    });
  });

  it('summarizes relay transcript payloads by length instead of content', () => {
    const transcript = 'private transcript';
    const state = reduceHubStreamState(createInitialHubStreamState(), {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:00.000Z',
      event: {
        message: {
          type: 'relay.stt.result',
          requestId: 'stt-1',
          text: transcript,
          provider: 'fake-stt',
        },
      },
    });

    const traces = deriveOperationalTraces(state);

    expect(JSON.stringify(traces)).not.toContain(transcript);
    expect(traces[0]?.metadata.transcriptChars).toBe(transcript.length);
  });

  it('folds tool activity lifecycle events into grouped traces by id', () => {
    let state = createInitialHubStreamState('2026-06-17T00:00:00.000Z');
    for (const [index, phase] of (['started', 'progress', 'completed'] as const).entries()) {
      state = reduceHubStreamState(state, {
        type: 'hub.inbound',
        at: `2026-06-17T00:00:0${index + 1}.000Z`,
        event: {
          message: {
            type: 'tool.activity',
            data: { id: 'tool-1', tool: 'renderer', phase, timestamp: `ts-${index}` },
          },
        },
      });
    }

    const traces = deriveOperationalTraces(state);
    expect(traces.map((trace) => trace.status)).toEqual(['active', 'active', 'done']);
    expect(traces.every((trace) => trace.metadata.toolActivityId === 'tool-1')).toBe(true);
    expect(traces.every((trace) => trace.operationClass === 'tool_activity')).toBe(true);
  });

  it('summarizes approval lifecycle events without leaking redacted context', () => {
    const redacted = 'REDACTED-CONTEXT-STRING';
    let state = reduceHubStreamState(createInitialHubStreamState('2026-06-17T00:00:00.000Z'), {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:01.000Z',
      event: {
        message: {
          type: 'approval.requested',
          data: {
            id: 'ap-1',
            title: 'Send email',
            requestedAt: '2026-06-17T00:00:01.000Z',
            redactedContext: redacted,
            status: 'pending',
          },
        },
      },
    });
    state = reduceHubStreamState(state, {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:02.000Z',
      event: {
        message: {
          type: 'approval.resolved',
          data: { id: 'ap-1', status: 'denied', resolvedAt: '2026-06-17T00:00:02.000Z' },
        },
      },
    });

    const traces = deriveOperationalTraces(state);
    expect(JSON.stringify(traces)).not.toContain(redacted);
    expect(traces[0]).toMatchObject({ operationClass: 'approval_request', status: 'active' });
    expect(traces[1]).toMatchObject({ operationClass: 'approval_resolution', status: 'failed', summary: 'Approval denied' });
  });

  it('surfaces failures as failed traces', () => {
    const state = reduceHubStreamState(createInitialHubStreamState(), {
      type: 'hub.inbound',
      at: '2026-06-17T00:00:00.000Z',
      event: {
        message: {
          type: 'relay.error',
          requestId: 'tts-1',
          operation: 'tts',
          message: 'provider unavailable',
        },
      },
    });

    expect(deriveOperationalTraces(state)[0]).toMatchObject({
      operationClass: 'relay_tts',
      status: 'failed',
      summary: 'provider unavailable',
    });
  });
});
