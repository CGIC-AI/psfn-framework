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
      place: { id: 'office', name: 'Office' },
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
      place: { id: 'office', name: 'Office' },
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
    {
      type: 'approval.requested',
      data: {
        id: 'ap-1',
        title: 'Send outbound email',
        requestedAt: '2026-06-17T00:00:01.000Z',
        expiresAt: '2026-06-17T00:00:31.000Z',
        redactedContext: 'Redacted action summary',
        status: 'pending',
      },
    },
    {
      type: 'approval.resolved',
      data: { id: 'ap-1', status: 'approved', resolvedAt: '2026-06-17T00:00:05.000Z' },
    },
    {
      type: 'artifact.created',
      data: {
        id: 'art-1',
        label: 'Report',
        mediaType: 'image/png',
        provenance: 'tool:renderer',
        createdAt: '2026-06-17T00:00:01.000Z',
        previewable: true,
      },
    },
    {
      type: 'artifact.preview.result',
      requestId: 'req-1',
      artifactId: 'art-1',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
    },
    {
      type: 'artifact.preview.error',
      requestId: 'req-1',
      artifactId: 'art-1',
      message: 'Access denied',
    },
    {
      type: 'tool.activity',
      data: {
        id: 'tool-1',
        tool: 'renderer',
        phase: 'started',
        detail: 'rendering',
        timestamp: '2026-06-17T00:00:02.000Z',
      },
    },
  ];

  const clientMessages: ClientToHubMessage[] = [
    {
      type: 'hello',
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
    { type: 'approval.decision', id: 'ap-1', decision: 'approve' },
    { type: 'artifact.preview', requestId: 'req-1', artifactId: 'art-1' },
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

  const malformedHubFrames: Array<[string, string]> = [
    ['session.ready discriminator only', '{"type":"session.ready"}'],
    ['session.ready with browser credential echo', '{"type":"session.ready","sessionId":"s","channelId":"c","deviceId":"d","deviceName":"D","satelliteId":"sat","audioFormat":"text","credential":"secret"}'],
    ['hello.ack missing capabilities', '{"type":"hello.ack","sessionId":"s","channelId":"c","deviceId":"d","deviceName":"D","satelliteId":"sat","satelliteName":"S"}'],
    ['hello.ack malformed place', '{"type":"hello.ack","sessionId":"s","channelId":"c","deviceId":"d","deviceName":"D","satelliteId":"sat","satelliteName":"S","capabilities":{},"place":{"id":"office"}}'],
    ['message extra trust field', '{"type":"message","data":{"role":"assistant","content":"x","trusted":true}}'],
    ['approval.requested missing id', '{"type":"approval.requested","data":{"title":"t","requestedAt":"x","redactedContext":"y","status":"pending"}}'],
    ['approval.requested wrong status', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"x","redactedContext":"y","status":"approved"}}'],
    ['approval.resolved bad status', '{"type":"approval.resolved","data":{"id":"1","status":"maybe","resolvedAt":"x"}}'],
    ['artifact.created non-boolean previewable', '{"type":"artifact.created","data":{"id":"1","label":"l","mediaType":"m","provenance":"p","createdAt":"c","previewable":"yes"}}'],
    ['artifact.preview.result missing data', '{"type":"artifact.preview.result","requestId":"r","artifactId":"a","mediaType":"m"}'],
    ['artifact.preview.error missing message', '{"type":"artifact.preview.error","requestId":"r","artifactId":"a"}'],
    ['tool.activity bad phase', '{"type":"tool.activity","data":{"id":"1","tool":"t","phase":"paused","timestamp":"ts"}}'],
    ['tool.activity missing data', '{"type":"tool.activity"}'],
  ];

  it.each(malformedHubFrames)('fails closed on malformed hub frame: %s', (_label, frame) => {
    expect(() => parseHubToClientMessage(frame)).toThrow(HubFramingError);
  });

  it('parses an approval.requested carrying the wire contract v2 fields', () => {
    const message = parseHubToClientMessage(JSON.stringify({
      type: 'approval.requested',
      data: {
        id: 'ap-9',
        title: 'Grant web access',
        requestedAt: '2026-07-17T00:00:01.000Z',
        expiresAt: '2026-07-17T00:05:01.000Z',
        redactedContext: 'Shard requests outbound fetch',
        status: 'pending',
        attribution: {
          parentLabel: 'Purrsephone', parentId: 'p-1', shardLabel: 'research-shard', shardId: 's-1',
        },
        action: 'http.get https://example.com',
        scope: 'network:egress',
        reason: 'operator-approved research task',
        grantMode: { kind: 'ttl', ttlSeconds: 300 },
        sourceSystem: 'shard',
      },
    }));
    expect(message.type).toBe('approval.requested');
    if (message.type !== 'approval.requested') return;
    expect(message.data.attribution?.shardLabel).toBe('research-shard');
    expect(message.data.grantMode).toEqual({ kind: 'ttl', ttlSeconds: 300 });
    expect(message.data.sourceSystem).toBe('shard');
  });

  it('accepts a once grant mode and a parent-only attribution', () => {
    const message = parseHubToClientMessage(JSON.stringify({
      type: 'approval.requested',
      data: {
        id: 'ap-10',
        title: 'One-time tool use',
        requestedAt: '2026-07-17T00:00:01.000Z',
        redactedContext: 'ctx',
        status: 'pending',
        attribution: { parentLabel: 'Artie', parentId: 'p-2' },
        grantMode: { kind: 'once' },
      },
    }));
    if (message.type !== 'approval.requested') throw new Error('expected approval.requested');
    expect(message.data.grantMode).toEqual({ kind: 'once' });
    expect(message.data.attribution?.shardLabel).toBeUndefined();
  });

  const malformedV2Frames: Array<[string, string]> = [
    ['grantMode unknown kind', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","grantMode":{"kind":"forever"}}}'],
    ['grantMode ttl missing ttlSeconds', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","grantMode":{"kind":"ttl"}}}'],
    ['grantMode ttl negative', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","grantMode":{"kind":"ttl","ttlSeconds":-5}}}'],
    ['grantMode extra key', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","grantMode":{"kind":"once","ttlSeconds":5}}}'],
    ['attribution missing parentLabel', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","attribution":{"parentId":"p"}}}'],
    ['attribution extra key', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","attribution":{"parentLabel":"P","parentId":"p","evil":"x"}}}'],
    ['v2 unknown top-level key', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-07-17T00:00:01.000Z","redactedContext":"y","status":"pending","forged":"x"}}'],
  ];

  it.each(malformedV2Frames)('fails closed on malformed v2 approval frame: %s', (_label, frame) => {
    expect(() => parseHubToClientMessage(frame)).toThrow(HubFramingError);
  });

  it('rejects browser authority fields from the initial hello', () => {
    expect(() => serializeClientToHubMessage({
      type: 'hello',
      capabilities: {},
      deviceId: 'forged',
    } as unknown as ClientToHubMessage)).toThrow(HubFramingError);
  });

  it('rejects malformed client control messages', () => {
    const badDecision = { type: 'approval.decision', id: 'ap-1', decision: 'maybe' } as unknown as ClientToHubMessage;
    expect(() => serializeClientToHubMessage(badDecision)).toThrow(HubFramingError);

    const badPreview = { type: 'artifact.preview', artifactId: 'art-1' } as unknown as ClientToHubMessage;
    expect(() => serializeClientToHubMessage(badPreview)).toThrow(HubFramingError);
  });
});

describe('SSE parser primitive', () => {
  it('parses complete SSE events without changing payload types', () => {
    expect(parseSseEvents(': keepalive\n\nevent: message\ndata: {"type":"status"}\ndata: {"data":"ready"}\n\n')).toEqual([
      { event: 'message', data: '{"type":"status"}\n{"data":"ready"}' },
    ]);
  });
});
