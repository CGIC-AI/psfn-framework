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
