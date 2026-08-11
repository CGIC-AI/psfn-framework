import { describe, expect, it } from 'vitest';
import {
  OmiOpusFrameAssembler,
  parseOmiAudioPacket,
} from './omi-audio.js';

describe('Omi audio packets', () => {
  it('parses the little-endian sequence and sub-packet header', () => {
    expect(parseOmiAudioPacket(Uint8Array.of(0x34, 0x12, 0x02, 0xaa, 0xbb))).toEqual({
      sequence: 0x1234,
      subpacket: 2,
      payload: Uint8Array.of(0xaa, 0xbb),
    });
  });

  it('rejects an empty payload instead of feeding malformed Opus downstream', () => {
    expect(() => parseOmiAudioPacket(Uint8Array.of(0x00, 0x00, 0x00)))
      .toThrow('Omi audio packet has no Opus payload');
  });
});

describe('Omi Opus frame assembler', () => {
  it('uses the next sub-packet-zero marker to complete a frame', () => {
    const assembler = new OmiOpusFrameAssembler();

    expect(assembler.push(Uint8Array.of(0, 0, 0, 0xa1))).toEqual([]);
    expect(assembler.push(Uint8Array.of(1, 0, 0, 0xb1))).toEqual([
      { firstSequence: 0, lastSequence: 0, opus: Uint8Array.of(0xa1) },
    ]);
    expect(assembler.flush()).toEqual([
      { firstSequence: 1, lastSequence: 1, opus: Uint8Array.of(0xb1) },
    ]);
  });

  it('reassembles a frame split across consecutive BLE notifications', () => {
    const assembler = new OmiOpusFrameAssembler();

    assembler.push(Uint8Array.of(10, 0, 0, 0x11, 0x12));
    assembler.push(Uint8Array.of(11, 0, 1, 0x13));
    expect(assembler.push(Uint8Array.of(12, 0, 0, 0x21))).toEqual([
      { firstSequence: 10, lastSequence: 11, opus: Uint8Array.of(0x11, 0x12, 0x13) },
    ]);
  });

  it('drops an incomplete frame on a sequence gap and recovers at the next frame boundary', () => {
    const assembler = new OmiOpusFrameAssembler();

    assembler.push(Uint8Array.of(20, 0, 0, 0x11));
    expect(assembler.push(Uint8Array.of(22, 0, 1, 0x12))).toEqual([]);
    expect(assembler.droppedFrames).toBe(1);

    assembler.push(Uint8Array.of(23, 0, 0, 0x21));
    expect(assembler.push(Uint8Array.of(24, 0, 0, 0x31))).toEqual([
      { firstSequence: 23, lastSequence: 23, opus: Uint8Array.of(0x21) },
    ]);
  });

  it('accepts the 16-bit packet sequence wrapping to zero', () => {
    const assembler = new OmiOpusFrameAssembler();

    assembler.push(Uint8Array.of(0xff, 0xff, 0, 0x11));
    expect(assembler.push(Uint8Array.of(0x00, 0x00, 0, 0x21))).toHaveLength(1);
    expect(assembler.droppedFrames).toBe(0);
  });
});
