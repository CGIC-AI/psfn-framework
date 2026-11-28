// Minimal deterministic PNG encoder and decoder (8-bit RGBA, colour type 6).
//
// NODE-ONLY: imports node:zlib. Used exclusively by the offline sprite-sheet
// tooling (render-sprites.ts, pack-sprites.ts and their scripts/ CLIs) and its
// tests. It is never reached from the browser app entry, so it stays out of the
// vite bundle. Deterministic given fixed zlib level, which the byte-stability
// test relies on.

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/**
 * Encode an RGBA pixel buffer (length width*height*4) into PNG bytes.
 * Deterministic: identical input yields identical output.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba buffer length ${rgba.length} does not match ${width}x${height}x4`);
  }

  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), no interlace.
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filtered scanlines: filter byte 0 (None) prefixed to each row.
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), dst + 1);
  }

  const compressed = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [PNG_MAGIC, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Straight (non-premultiplied) RGBA, row-major, length width*height*4. */
  readonly rgba: Uint8Array;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

/**
 * Decode an 8-bit, non-interlaced RGBA (colour type 6) or RGB (colour type 2)
 * PNG. Every other format is rejected rather than approximated: sprite source
 * art must carry real alpha, and a silent conversion would hide a bad export.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!isPng(bytes)) throw new Error('not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_MAGIC.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (offset + 12 + size > bytes.length) throw new Error(`truncated PNG chunk ${type}`);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== view.getUint32(offset + 8 + size)) {
      throw new Error(`PNG chunk ${type} has a bad CRC`);
    }
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, colourType, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || (colourType !== 6 && colourType !== 2) || interlace !== 0) {
        throw new Error(`unsupported PNG format (depth ${depth}, colour type ${colourType}, interlace ${interlace}); `
          + 'expected 8-bit non-interlaced RGBA or RGB');
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + size;
  }
  if (!ended || channels === 0 || idat.length === 0) throw new Error('PNG is missing IHDR, IDAT or IEND');

  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data length does not match its header');

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[dst + x - channels]! : 0;
      const up = y > 0 ? pixels[dst - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels]! : 0;
      const value = raw[src + x]!;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else throw new Error(`invalid PNG filter type ${filter} on row ${y}`);
      pixels[dst + x] = (value + predicted) & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i]!;
    rgba[j + 1] = pixels[i + 1]!;
    rgba[j + 2] = pixels[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
