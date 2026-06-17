import { describe, expect, it } from 'vitest';
import type { ClientToHubMessage, HubToClientMessage } from './events.js';
import {
  HubFramingError,
  parseHubToClientMessage,
  parseSseEvents,
  serializeClientToHubMessage,
} from './framing.js';

describe('hub websocket framing', () => {
  const hubMessages: HubToClientMessage[] = [
    {
      type: 'session.ready',
      sessionId: 'session-1',
      channelId: 'satellite.endpoint:session-1',
      deviceId: 'phone-browser',
      deviceName: 'Phone Browser',
      satelliteId: 'phone-browser',
      audioFormat: 'text',
      identity: {
        source: 'framework',
        companion: { id: 'companion-1', name: 'Purrsephone' },
        user: { id: 'user-1', name: 'V', canonicalContactId: 'contact-1' },
      },
    },
    {
      type: 'hello.ack',
      sessionId: 'session-1',
      channelId: 'satellite.endpoint:session-1',
      deviceId: 'phone-browser',
      deviceName: 'Phone Browser',
      satelliteId: 'phone-browser',
      satelliteName: 'PSFN Satellite Mobile Chat App',
      capabilities: {
        input: ['text'],
        output: ['text', 'subtitle'],
        control: ['interrupt', 'presence', 'session_attach'],
        safety: ['confirmation_required', 'local_only'],
      },
    },
    { type: 'status', data: 'ready' },
    { type: 'text', data: 'audio-init' },
    { type: 'audio', data: 'YWJj' },
    {
      type: 'message',
      data: { role: 'assistant', content: 'hello', live: true, final: false },
    },
    { type: 'action', data: 'interrupt' },
    { type: 'error-event', data: { message: 'hub rejected request' } },
    {
      type: 'relay.stt.result',
      requestId: 'stt-1',
      text: 'hi',
      provider: 'fake-stt',
      latencyMs: 42,
    },
    { type: 'relay.tts.chunk', requestId: 'tts-1', audio: 'YWJj' },
    { type: 'relay.tts.done', requestId: 'tts-1', mimeType: 'audio/wav' },
    {
      type: 'relay.error',
      requestId: 'tts-1',
      operation: 'tts',
      message: 'provider unavailable',
    },
    { type: 'pong', sentAt: 123 },
    { type: 'assistant.interrupted', sessionId: 'session-1' },
  ];

  const clientMessages: ClientToHubMessage[] = [
    {
      type: 'hello',
      deviceId: 'phone-browser',
      deviceName: 'Phone Browser',
      sessionId: 'session-1',
      satelliteId: 'phone-browser',
      satelliteName: 'PSFN Satellite Mobile Chat App',
      capabilities: {
        input: ['text'],
        output: ['text', 'subtitle'],
        control: ['interrupt', 'presence', 'session_attach'],
        safety: ['confirmation_required'],
      },
    },
    { type: 'audio', audio: 'YWJj' },
    { type: 'user.text', text: 'hello', interrupt: true },
    { type: 'text', data: 'audio-end' },
    { type: 'ping', sentAt: 123 },
    { type: 'interrupt' },
    { type: 'relay.stt', requestId: 'stt-1', audio: 'YWJj', mimeType: 'audio/wav' },
    { type: 'relay.tts', requestId: 'tts-1', text: 'hello', voice: 'default' },
    { type: 'turn.start', interrupt: true },
    { type: 'turn.end', reason: 'typed_submit' },
  ];

  it.each(hubMessages)('parses known hub message %s', (message) => {
    expect(parseHubToClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each(clientMessages)('serializes known client message %s', (message) => {
    expect(JSON.parse(serializeClientToHubMessage(message))).toEqual(message);
  });

  it('rejects unknown hub message types', () => {
    expect(() => parseHubToClientMessage('{"type":"turn.started"}')).toThrow(HubFramingError);
  });

  it('rejects malformed hub frames', () => {
    expect(() => parseHubToClientMessage('{')).toThrow(HubFramingError);
  });

  it('rejects unknown client message types', () => {
    const message = { type: 'session.reset' } as unknown as ClientToHubMessage;

    expect(() => serializeClientToHubMessage(message)).toThrow(HubFramingError);
  });
});

describe('SSE parser primitive', () => {
  it('parses complete SSE events without changing payload types', () => {
    expect(parseSseEvents(': keepalive\n\nevent: message\ndata: {"type":"status"}\ndata: {"data":"ready"}\n\n')).toEqual([
      { event: 'message', data: '{"type":"status"}\n{"data":"ready"}' },
    ]);
  });
});
