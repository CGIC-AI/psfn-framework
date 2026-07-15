import { describe, expect, it } from 'vitest';
import { VoiceWireDecodeError, parseInboundVoiceWireFrame, serializeVoiceWireFrame } from './serializer.js';
import { VOICE_WIRE_PROTOCOL } from './types.js';

describe('voice websocket serializer', () => {
  it('round-trips a valid inbound frame', () => {
    const raw = serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'session-1',
    });

    const frame = parseInboundVoiceWireFrame(raw, 1024);
    expect(frame).toEqual({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'session-1',
    });
  });

  it('round-trips audio bytes in one binary frame without base64 expansion', () => {
    const raw = serializeVoiceWireFrame({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'session-1',
      seq: 7,
      timestampMs: 1_700_000_000_000,
      audio: new Uint8Array([0, 1, 2, 253, 254, 255]),
    });

    expect(raw).toBeInstanceOf(Uint8Array);
    const frame = parseInboundVoiceWireFrame(raw, 1024);
    expect(frame).toEqual({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'session-1',
      seq: 7,
      timestampMs: 1_700_000_000_000,
      audio: new Uint8Array([0, 1, 2, 253, 254, 255]),
    });
  });

  it('rejects legacy JSON audio payloads instead of silently decoding a compatibility shape', () => {
    const legacy = JSON.stringify({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'session-1',
      seq: 1,
      audioBase64: 'AQID',
    });

    expect(() => parseInboundVoiceWireFrame(legacy, 1024)).toThrowError(VoiceWireDecodeError);
  });

  it('rejects malformed binary audio envelopes', () => {
    expect(() => parseInboundVoiceWireFrame(new Uint8Array([1, 2, 3]), 1024))
      .toThrowError(VoiceWireDecodeError);
  });

  it('rejects oversize frames', () => {
    const oversized = JSON.stringify({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'session-1',
      payload: 'x'.repeat(500),
    });

    expect(() => parseInboundVoiceWireFrame(oversized, 64)).toThrowError(VoiceWireDecodeError);
    try {
      parseInboundVoiceWireFrame(oversized, 64);
    } catch (error) {
      expect((error as VoiceWireDecodeError).code).toBe('FRAME_TOO_LARGE');
    }
  });

  it('rejects non-inbound frame types', () => {
    const outbound = JSON.stringify({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'ack',
      ackType: 'session.start',
      sessionId: 'session-1',
    });

    expect(() => parseInboundVoiceWireFrame(outbound, 1024)).toThrowError(VoiceWireDecodeError);
    try {
      parseInboundVoiceWireFrame(outbound, 1024);
    } catch (error) {
      expect((error as VoiceWireDecodeError).code).toBe('NOT_INBOUND');
    }
  });
});
