import { inflateRawSync } from 'node:zlib';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_MAX_COMMENT_BYTES = 65_535;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

export class ZipContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipContainerError';
  }
}

function readUInt16Le(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.byteLength) {
    throw new ZipContainerError('ZIP header is truncated');
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32Le(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) {
    throw new ZipContainerError('ZIP header is truncated');
  }
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.byteLength - ZIP_MAX_COMMENT_BYTES - 22);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32Le(bytes, offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipContainerError('ZIP end of central directory was not found');
}

function decodeZipEntryName(bytes: Uint8Array, utf8: boolean): string {
  const decoder = utf8
    ? new TextDecoder('utf-8', { fatal: false })
    : new TextDecoder('latin1', { fatal: false });
  return decoder.decode(bytes).replace(/\0/g, '').trim();
}

function resolveZipEntryDataOffset(bytes: Uint8Array, localHeaderOffset: number): number {
  if (readUInt32Le(bytes, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipContainerError('ZIP local file header is invalid');
  }
  const nameLength = readUInt16Le(bytes, localHeaderOffset + 26);
  const extraLength = readUInt16Le(bytes, localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset > bytes.byteLength) {
    throw new ZipContainerError('ZIP local file data offset is outside the container');
  }
  return dataOffset;
}

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength < 22) {
    throw new ZipContainerError('ZIP container is too small');
  }

  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readUInt16Le(bytes, eocdOffset + 4);
  const centralDirectoryDisk = readUInt16Le(bytes, eocdOffset + 6);
  const entriesOnDisk = readUInt16Le(bytes, eocdOffset + 8);
  const entryCount = readUInt16Le(bytes, eocdOffset + 10);
  const centralDirectorySize = readUInt32Le(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32Le(bytes, eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipContainerError('split ZIP archives are not supported');
  }
  if (centralDirectoryOffset === 0xffffffff || centralDirectorySize === 0xffffffff) {
    throw new ZipContainerError('ZIP64 containers are not supported');
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.byteLength) {
    throw new ZipContainerError('ZIP central directory is outside the container');
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32Le(bytes, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipContainerError('ZIP central directory entry is invalid');
    }

    const flags = readUInt16Le(bytes, offset + 8);
    const compressionMethod = readUInt16Le(bytes, offset + 10);
    const compressedSize = readUInt32Le(bytes, offset + 20);
    const uncompressedSize = readUInt32Le(bytes, offset + 24);
    const nameLength = readUInt16Le(bytes, offset + 28);
    const extraLength = readUInt16Le(bytes, offset + 30);
    const commentLength = readUInt16Le(bytes, offset + 32);
    const localHeaderOffset = readUInt32Le(bytes, offset + 42);
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      throw new ZipContainerError('ZIP64 entries are not supported');
    }

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) {
      throw new ZipContainerError('ZIP central directory entry name is truncated');
    }
    const name = decodeZipEntryName(bytes.slice(nameStart, nameEnd), (flags & 0x0800) !== 0);
    const dataOffset = resolveZipEntryDataOffset(bytes, localHeaderOffset);
    if (dataOffset + compressedSize > bytes.byteLength) {
      throw new ZipContainerError('ZIP entry data is outside the container');
    }

    if (name && !name.endsWith('/')) {
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        dataOffset,
      });
    }

    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntryData(input: {
  bytes: Uint8Array;
  entry: ZipEntry;
  maxUncompressedBytes: number;
}): Buffer {
  if (input.entry.uncompressedSize > input.maxUncompressedBytes) {
    throw new ZipContainerError(
      `ZIP entry "${input.entry.name}" is too large (${input.entry.uncompressedSize} bytes)`,
    );
  }

  const compressed = input.bytes.slice(
    input.entry.dataOffset,
    input.entry.dataOffset + input.entry.compressedSize,
  );
  let data: Buffer;
  if (input.entry.compressionMethod === 0) {
    data = Buffer.from(compressed);
  } else if (input.entry.compressionMethod === 8) {
    data = inflateRawSync(Buffer.from(compressed));
  } else {
    throw new ZipContainerError(
      `ZIP entry "${input.entry.name}" uses unsupported compression method ${input.entry.compressionMethod}`,
    );
  }

  if (data.byteLength !== input.entry.uncompressedSize) {
    throw new ZipContainerError(`ZIP entry "${input.entry.name}" decompressed to an unexpected size`);
  }
  return data;
}

export function findZipEntry(entries: readonly ZipEntry[], name: string): ZipEntry | null {
  const normalized = name.toLowerCase();
  return entries.find(entry => entry.name.toLowerCase() === normalized) ?? null;
}

export function listZipEntryNames(bytes: Uint8Array): string[] {
  return readZipEntries(bytes).map(entry => entry.name);
}
