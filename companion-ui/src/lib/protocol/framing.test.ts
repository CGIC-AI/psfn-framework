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
      type: 'approval.requested',
      data: {
        id: 'ap-2',
        title: 'Send outbound email',
        requestedAt: '2026-06-17T00:00:01.000Z',
        expiresAt: '2026-06-17T00:00:31.000Z',
        redactedContext: 'Redacted action summary',
        status: 'pending',
        sourceSystem: 'tool-access',
        attribution: { parentId: 'companion-1', parentLabel: 'Purrsephone', shardId: 'shard-1', shardLabel: 'Shard' },
        action: 'send email',
        scope: 'outbound',
        reason: 'Redacted action summary',
        grantMode: { kind: 'once' },
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
      eventCapabilities: ['approvals.v2'],
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
    ['approval.requested malformed v2 grantMode', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-06-17T00:00:01.000Z","redactedContext":"y","status":"pending","grantMode":{"kind":"forever"}}}'],
    ['approval.requested malformed v2 attribution', '{"type":"approval.requested","data":{"id":"1","title":"t","requestedAt":"2026-06-17T00:00:01.000Z","redactedContext":"y","status":"pending","attribution":{"parentLabel":"p"}}}'],
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

  it('tolerates unknown future keys on approval.requested (approvals forward-compat)', () => {
    const frame = JSON.stringify({
      type: 'approval.requested',
      data: {
        id: 'ap-9',
        title: 'Future action',
        requestedAt: '2026-06-17T00:00:01.000Z',
        redactedContext: 'ctx',
        status: 'pending',
        sourceSystem: 'cogsec',
        grantMode: { kind: 'once' },
        // a key a NEWER server added that this client build does not know
        futureField: { nested: 'value' },
      },
    });
    const parsed = parseHubToClientMessage(frame);
    expect(parsed.type).toBe('approval.requested');
  });

  it('still rejects unknown keys on other message types (exactRecord unchanged)', () => {
    // approval.resolved is NOT tolerant — an unknown key must fail closed.
    expect(() => parseHubToClientMessage(
      '{"type":"approval.resolved","data":{"id":"1","status":"approved","resolvedAt":"2026-06-17T00:00:01.000Z","surprise":1}}',
    )).toThrow(HubFramingError);
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
