import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipContainerError, readZipEntries, readZipEntryData } from './zip-container.js';

interface ZipFixtureEntry {
  name: string;
  compressed: Buffer;
  compressedSize?: number;
  uncompressedSize: number;
  compressionMethod: number;
}

/** Builds a minimal single-disk ZIP container the parser accepts; CRCs are unchecked. */
function buildZip(entries: ZipFixtureEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressedSize = entry.compressedSize ?? entry.compressed.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(entry.compressionMethod, 8);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(entry.uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localHeaderOffset = offset;
    chunks.push(localHeader, name, entry.compressed);
    offset += localHeader.length + name.length + entry.compressed.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.compressionMethod, 10);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localHeaderOffset, 42);
    centralDirectory.push(Buffer.concat([central, name]));
  }
  const centralBytes = Buffer.concat(centralDirectory);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralBytes.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, endOfCentralDirectory]));
}

describe('readZipEntryData', () => {
  it('round-trips a deflated entry within the size limit', () => {
    const payload = Buffer.from('hello archive contents\n', 'utf8');
    const bytes = buildZip([{
      name: 'docs/readme.txt',
      compressed: deflateRawSync(payload),
      uncompressedSize: payload.length,
      compressionMethod: 8,
    }]);

    const entries = readZipEntries(bytes);
    expect(entries).toHaveLength(1);
    const data = readZipEntryData({ bytes, entry: entries[0], maxUncompressedBytes: 1024 });
    expect(data.equals(payload)).toBe(true);
  });

  it('rejects entries whose declared uncompressed size exceeds the limit', () => {
    const payload = Buffer.alloc(4096, 0x61);
    const bytes = buildZip([{
      name: 'big.txt',
      compressed: deflateRawSync(payload),
      uncompressedSize: payload.length,
      compressionMethod: 8,
    }]);

    const [entry] = readZipEntries(bytes);
    expect(() => readZipEntryData({ bytes, entry, maxUncompressedBytes: 1024 }))
      .toThrow('is too large');
  });

  it('bounds inflate output when the declared size lies below the real expansion', () => {
    // A zip-bomb style entry: tiny compressed payload, huge real expansion,
    // and a declared uncompressedSize small enough to pass the pre-check.
    const bomb = deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0));
    const bytes = buildZip([{
      name: 'bomb.txt',
      compressed: bomb,
      uncompressedSize: 100,
      compressionMethod: 8,
    }]);

    const [entry] = readZipEntries(bytes);
    let caught: unknown;
    try {
      readZipEntryData({ bytes, entry, maxUncompressedBytes: 1024 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipContainerError);
    expect((caught as Error).message).toContain('failed to decompress within the 1024-byte limit');
  });

  it('still rejects declared-size mismatches for outputs under the limit', () => {
    const payload = Buffer.from('short', 'utf8');
    const bytes = buildZip([{
      name: 'mismatch.txt',
      compressed: deflateRawSync(payload),
      uncompressedSize: payload.length + 3,
      compressionMethod: 8,
    }]);

    const [entry] = readZipEntries(bytes);
    expect(() => readZipEntryData({ bytes, entry, maxUncompressedBytes: 1024 }))
      .toThrow('decompressed to an unexpected size');
  });
});
