// @vitest-environment node

import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png.js';

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Hand-built PNG using one row filter per scanline, so decoding is checked
// against every PNG filter type rather than only the encoder's filter 0.
function filteredPng(width: number, rgba: Uint8Array, filters: readonly number[], colourType = 6): Uint8Array {
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const height = filters.length;
  const raw: number[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : rgba[y * stride + x]!);
  for (let y = 0; y < height; y += 1) {
    raw.push(filters[y]!);
    for (let x = 0; x < stride; x += 1) {
      const left = at(x - channels, y);
      const up = at(x, y - 1);
      const upLeft = at(x - channels, y - 1);
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
        ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filters[y]!]!;
      raw.push((at(x, y) - predicted) & 0xff);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]));
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff);
}

describe('decodePng', () => {
  it('round-trips the encoder output exactly', () => {
    const rgba = pattern(7 * 5 * 4);
    const decoded = decodePng(encodePng(7, 5, rgba));
    expect(decoded.width).toBe(7);
    expect(decoded.height).toBe(5);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('undoes every scanline filter type', () => {
    const rgba = pattern(6 * 5 * 4);
    const decoded = decodePng(filteredPng(6, rgba, [0, 1, 2, 3, 4]));
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it('expands RGB to opaque RGBA', () => {
    const rgb = pattern(3 * 2 * 3);
    const decoded = decodePng(filteredPng(3, rgb, [1, 4], 2));
    expect(decoded.rgba[3]).toBe(255);
    expect(Array.from(decoded.rgba.subarray(4, 7))).toEqual(Array.from(rgb.subarray(3, 6)));
  });

  it('rejects unsupported formats and corruption instead of guessing', () => {
    expect(() => decodePng(filteredPng(2, pattern(12), [0, 0], 0))).toThrow(/unsupported PNG format/);
    const png = encodePng(2, 2, pattern(16));
    const corrupt = png.slice();
    corrupt[corrupt.length - 20] = corrupt[corrupt.length - 20]! ^ 0xff;
    expect(() => decodePng(corrupt)).toThrow();
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});
