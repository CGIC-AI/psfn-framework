import { describe, expect, it } from 'vitest';
import {
  RcspStreamDecoder,
  encodeRcspCommand,
} from './rcsp-frame.js';

describe('JieLi RCSP framing', () => {
  it('encodes a command exactly like the live E1 capture', () => {
    expect(toHex(encodeRcspCommand(0xe1, 0x43))).toBe('fedcbac0e1000143ef');
  });

  it('encodes the stock PCM microphone start command', () => {
    expect(toHex(encodeRcspCommand(0x04, 0x41, Uint8Array.of(0x00))))
      .toBe('fedcbac00400024100ef');
  });

  it('decodes a captured response', () => {
    const decoder = new RcspStreamDecoder();

    expect(decoder.push(fromHex('fedcba00e100080043000000000000ef'))).toEqual([{
      kind: 'response',
      flags: 0x00,
      opcode: 0xe1,
      status: 0x00,
      sequence: 0x43,
      data: new Uint8Array(6),
    }]);
  });

  it('reassembles an audio command fragmented across BLE notifications', () => {
    const decoder = new RcspStreamDecoder();

    expect(decoder.push(fromHex('fedcba80010006330400'))).toEqual([]);
    expect(decoder.push(fromHex('010203ef'))).toEqual([{
      kind: 'command',
      flags: 0x80,
      opcode: 0x01,
      needsResponse: false,
      sequence: 0x33,
      data: Uint8Array.of(0x04, 0x00, 0x01, 0x02, 0x03),
    }]);
  });

  it('decodes multiple frames from one notification', () => {
    const decoder = new RcspStreamDecoder();
    const first = fromHex('fedcba000400020041ef');
    const second = fromHex('fedcba800100033304aaef');

    expect(decoder.push(concat(first, second))).toEqual([
      {
        kind: 'response',
        flags: 0x00,
        opcode: 0x04,
        status: 0x00,
        sequence: 0x41,
        data: new Uint8Array(),
      },
      {
        kind: 'command',
        flags: 0x80,
        opcode: 0x01,
        needsResponse: false,
        sequence: 0x33,
        data: Uint8Array.of(0x04, 0xaa),
      },
    ]);
  });

  it('resynchronizes after unrelated bytes and a corrupt trailer', () => {
    const decoder = new RcspStreamDecoder();
    const corrupt = fromHex('fedcba800100033304aa00');
    const valid = fromHex('fedcba800100033404bbef');

    expect(decoder.push(concat(Uint8Array.of(0x01, 0x02), corrupt, valid))).toEqual([{
      kind: 'command',
      flags: 0x80,
      opcode: 0x01,
      needsResponse: false,
      sequence: 0x34,
      data: Uint8Array.of(0x04, 0xbb),
    }]);
  });
});

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
