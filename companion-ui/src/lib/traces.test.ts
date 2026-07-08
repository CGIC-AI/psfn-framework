import { describe, expect, it } from 'vitest';
import { createInitialHubStreamState, reduceHubStreamState } from './stream/hub-stream.js';
import { deriveOperationalTraces } from './traces.js';

describe('operational traces', () => {
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
