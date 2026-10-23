import { describe, expect, it } from 'vitest';
import {
  GatewayRpcFrameSizeError,
  GatewayRpcNdjsonFramer,
  serializeGatewayRpcFrame,
} from './transport-framing.js';

describe('Gateway RPC frame serialization', () => {
  it('counts serialized UTF-8 including escaped JSON characters', () => {
    expect(serializeGatewayRpcFrame({ value: 'é\n' })).toEqual({
      serialized: '{"value":"é\\n"}',
      serializedBytes: 16,
    });
  });

  it('accepts exactly 64 MiB and rejects the next UTF-8 byte', () => {
    const payload = { data: 'é'.repeat((64 * 1024 * 1024 - 12) / 2) + 'x' };
    expect(serializeGatewayRpcFrame(payload).serializedBytes).toBe(67_108_864);
    payload.data += 'x';
    expect(() => serializeGatewayRpcFrame(payload)).toThrow(GatewayRpcFrameSizeError);
  });

  it('does not expose content-bearing serialization failures', () => {
    const secret = 'invented-sensitive-marker';
    const payload = { toJSON() { throw new Error(secret); } };
    expect(() => serializeGatewayRpcFrame(payload)).toThrow('Gateway RPC frame serialization failed');
    expect(() => serializeGatewayRpcFrame(undefined)).toThrow('Gateway RPC frame is not JSON serializable');
    expect(() => serializeGatewayRpcFrame(1n)).toThrow('Gateway RPC frame serialization failed');
  });
});

describe('Gateway RPC NDJSON byte framing', () => {
  it('preserves UTF-8 split at every byte, split CRLF, bare CR and final unterminated lines', () => {
    const framer = new GatewayRpcNdjsonFramer();
    const frames: string[] = [];
    const onFrame = (frame: string) => { frames.push(frame); };
    for (const byte of Buffer.from('"☃😀é"\r\n"cr"\r"lf"\n"eof"')) {
      framer.push(Buffer.from([byte]), onFrame);
    }
    framer.end(onFrame);
    expect(frames).toEqual(['"☃😀é"', '"cr"', '"lf"', '"eof"']);
  });

  it('releases and ignores pending bytes after close, including the remainder of the current chunk', () => {
    const framer = new GatewayRpcNdjsonFramer();
    const frames: string[] = [];
    const onFrame = (frame: string) => { frames.push(frame); framer.close(); };
    framer.push(Buffer.from('"first"\n"never"\n'), onFrame);
    framer.push(Buffer.from('"also-never"\n'), onFrame);
    framer.end(onFrame);
    expect(frames).toEqual(['"first"']);
  });

  it('rejects one-byte overflow without retaining it, decoding or dispatching a line', () => {
    const framer = new GatewayRpcNdjsonFramer();
    const frames: string[] = [];
    const onFrame = (frame: string) => { frames.push(frame); };
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let index = 0; index < 64; index += 1) framer.push(chunk, onFrame);
    expect(() => framer.push(Buffer.from('x'), onFrame)).toThrow(GatewayRpcFrameSizeError);
    framer.push(Buffer.from('\n"never"\n'), onFrame);
    framer.end(onFrame);
    expect(frames).toEqual([]);
  });
});
