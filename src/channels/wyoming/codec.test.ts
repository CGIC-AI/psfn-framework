import { describe, expect, it } from 'vitest';
import { WyomingFrameCodec } from './codec.js';
import { WyomingCodecError } from './protocol.js';

function splitBuffer(buffer: Buffer, splitAt: number): [Buffer, Buffer] {
  return [buffer.subarray(0, splitAt), buffer.subarray(splitAt)];
}

describe('WyomingFrameCodec', () => {
  it('round-trips framed events with data and binary payload', () => {
    const codec = new WyomingFrameCodec();
    const encoded = codec.encode({
      type: 'audio.chunk',
      data: {
        session_id: 'session-1',
        seq: 3,
      },
      payload: new Uint8Array([1, 2, 3, 4]),
      headers: {
        service: 'asr',
      },
    });

    const [left, right] = splitBuffer(encoded, 9);
    expect(codec.push(left)).toEqual([]);

    const decoded = codec.push(right);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual({
      type: 'audio.chunk',
      data: {
        session_id: 'session-1',
        seq: 3,
      },
      payload: new Uint8Array([1, 2, 3, 4]),
      headers: {
        service: 'asr',
      },
    });
  });

  it('parses multiple frames from one chunk', () => {
    const codec = new WyomingFrameCodec();

    const first = codec.encode({ type: 'describe' });
    const second = codec.encode({
      type: 'session.start',
      data: { session_id: 'session-1' },
    });

    const frames = codec.push(Buffer.concat([first, second]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: 'describe', data: undefined, payload: undefined, headers: undefined });
    expect(frames[1]).toEqual({
      type: 'session.start',
      data: { session_id: 'session-1' },
      payload: undefined,
      headers: undefined,
    });
  });

  it('rejects malformed header lines', () => {
    const codec = new WyomingFrameCodec();
    expect(() => codec.push(Buffer.from('type describe\n\n', 'utf8'))).toThrowError(WyomingCodecError);

    try {
      codec.push(Buffer.from('type describe\n\n', 'utf8'));
    } catch (error) {
      expect((error as WyomingCodecError).code).toBe('INVALID_HEADER');
    }
  });

  it('rejects invalid payload_length', () => {
    const codec = new WyomingFrameCodec();
    expect(() => codec.push(Buffer.from('type: audio.chunk\npayload_length: nope\n\n', 'utf8'))).toThrowError(WyomingCodecError);

    try {
      codec.push(Buffer.from('type: audio.chunk\npayload_length: nope\n\n', 'utf8'));
    } catch (error) {
      expect((error as WyomingCodecError).code).toBe('INVALID_PAYLOAD_LENGTH');
    }
  });

  it('rejects payloads over configured bounds', () => {
    const codec = new WyomingFrameCodec({
      maxPayloadBytes: 4,
    });

    expect(() => codec.push(Buffer.from('type: audio.chunk\npayload_length: 8\n\n12345678', 'utf8'))).toThrowError(WyomingCodecError);

    try {
      codec.push(Buffer.from('type: audio.chunk\npayload_length: 8\n\n12345678', 'utf8'));
    } catch (error) {
      expect((error as WyomingCodecError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('rejects non-object data headers', () => {
    const codec = new WyomingFrameCodec();

    expect(() => codec.push(Buffer.from('type: describe\ndata: [1,2,3]\n\n', 'utf8'))).toThrowError(WyomingCodecError);

    try {
      codec.push(Buffer.from('type: describe\ndata: [1,2,3]\n\n', 'utf8'));
    } catch (error) {
      expect((error as WyomingCodecError).code).toBe('INVALID_DATA');
    }
  });
});
