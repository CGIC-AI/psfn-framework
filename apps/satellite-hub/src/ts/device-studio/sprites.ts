import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import type { DisplayShape, Provenance } from "./model.js";
import { getConcreteDeviceProfile } from "./profiles.js";

export type SpriteFrameKind = "expression" | "viseme";

export interface SpriteSourceFrame {
  id: string;
  kind: SpriteFrameKind;
  png: Uint8Array;
  provenance?: Provenance;
  expectedWidth?: number;
  expectedHeight?: number;
}

export interface SpriteSheetPackInput {
  profileId: string;
  frames: SpriteSourceFrame[];
  atlasId?: string;
}

export interface SpriteAtlasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteSafeAreaMetadata {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteRoundClipMetadata {
  shape: "circle";
  centerX: number;
  centerY: number;
  radius: number;
}

export interface SpriteManifestFrame {
  id: string;
  kind: SpriteFrameKind;
  width: number;
  height: number;
  atlasRect: SpriteAtlasRect;
  safeArea: SpriteSafeAreaMetadata;
  roundClip?: SpriteRoundClipMetadata;
  source: {
    contentHash: string;
    provenance?: Provenance;
  };
}

export interface SpriteSheetManifest {
  schemaVersion: 1;
  atlas: {
    id: string;
    width: number;
    height: number;
    pngContentHash: string;
  };
  profile: {
    id: string;
    display: {
      width: number;
      height: number;
      shape: DisplayShape;
      safeArea: SpriteSafeAreaMetadata;
      roundClip?: SpriteRoundClipMetadata;
    };
  };
  frames: SpriteManifestFrame[];
}

export interface SpriteSheetPackResult {
  atlasPng: Uint8Array;
  manifest: SpriteSheetManifest;
}

export interface RgbaPngImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface SpriteValidationIssue {
  path: string;
  message: string;
}

export class SpriteSheetPackingError extends Error {
  readonly issues: SpriteValidationIssue[];

  constructor(issues: SpriteValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "SpriteSheetPackingError";
    this.issues = issues;
  }
}

interface DecodedSourceFrame {
  id: string;
  kind: SpriteFrameKind;
  image: RgbaPngImage;
  contentHash: string;
  provenance?: Provenance;
  sourceIndex: number;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SPRITE_KIND_ORDER: Record<SpriteFrameKind, number> = {
  expression: 0,
  viseme: 1,
};
const BYTES_PER_PIXEL = 4;

export function packDeviceSpriteSheet(input: SpriteSheetPackInput): SpriteSheetPackResult {
  const issues = validateSpriteSheetPackInputShape(input);
  const profile = getConcreteDeviceProfile(input.profileId);
  const sourceFrames = Array.isArray(input.frames) ? input.frames : [];

  if (!profile) {
    issues.push({
      path: "profileId",
      message: `Unsupported Device Studio profile ID "${input.profileId}"`,
    });
  }

  const duplicateKeys = findDuplicateFrameKeys(sourceFrames);
  for (const key of duplicateKeys) {
    issues.push({
      path: "frames",
      message: `Duplicate sprite frame "${key.kind}:${key.id}"`,
    });
  }

  const decodedFrames: DecodedSourceFrame[] = [];
  for (const [sourceIndex, frame] of sourceFrames.entries()) {
    if (!isValidFrameKind(frame.kind)) {
      issues.push({
        path: `frames[${sourceIndex}].kind`,
        message: `Unsupported sprite frame kind "${String(frame.kind)}"`,
      });
      continue;
    }

    try {
      const image = decodeRgbaPng(frame.png);
      const contentHash = sha256Hex(frame.png);

      if (frame.expectedWidth !== undefined && frame.expectedWidth !== image.width) {
        issues.push({
          path: `frames[${sourceIndex}].expectedWidth`,
          message: `Expected width ${frame.expectedWidth} does not match PNG width ${image.width}`,
        });
      }
      if (frame.expectedHeight !== undefined && frame.expectedHeight !== image.height) {
        issues.push({
          path: `frames[${sourceIndex}].expectedHeight`,
          message: `Expected height ${frame.expectedHeight} does not match PNG height ${image.height}`,
        });
      }
      if (profile && image.width > profile.display.width) {
        issues.push({
          path: `frames[${sourceIndex}].png`,
          message: `Frame width ${image.width} exceeds ${profile.id} display width ${profile.display.width}`,
        });
      }
      if (profile && image.height > profile.display.height) {
        issues.push({
          path: `frames[${sourceIndex}].png`,
          message: `Frame height ${image.height} exceeds ${profile.id} display height ${profile.display.height}`,
        });
      }

      decodedFrames.push({
        id: frame.id,
        kind: frame.kind,
        image,
        contentHash,
        provenance: frame.provenance,
        sourceIndex,
      });
    } catch (error) {
      issues.push({
        path: `frames[${sourceIndex}].png`,
        message: error instanceof Error ? error.message : "Invalid PNG source frame",
      });
    }
  }

  if (issues.length > 0) {
    throw new SpriteSheetPackingError(issues);
  }
  if (!profile) {
    throw new SpriteSheetPackingError([{ path: "profileId", message: "Unsupported Device Studio profile ID" }]);
  }

  const sortedFrames = [...decodedFrames].sort(compareDecodedFrames);
  const placements = placeFrames(sortedFrames, profile.display.width);
  const atlasHeight = placements.height;
  const atlasPixels = new Uint8Array(profile.display.width * atlasHeight * BYTES_PER_PIXEL);

  for (const placement of placements.frames) {
    copyFramePixels(placement.frame.image, atlasPixels, profile.display.width, placement.rect.x, placement.rect.y);
  }

  const atlasPng = encodeRgbaPng({
    width: profile.display.width,
    height: atlasHeight,
    data: atlasPixels,
  });
  const safeArea = profile.display.safeArea ?? {
    x: 0,
    y: 0,
    width: profile.display.width,
    height: profile.display.height,
  };
  const roundClip = profile.display.shape === "round"
    ? makeRoundClip(profile.display.width, profile.display.height, safeArea)
    : undefined;
  const manifestFrames: SpriteManifestFrame[] = placements.frames.map((placement) => ({
    id: placement.frame.id,
    kind: placement.frame.kind,
    width: placement.frame.image.width,
    height: placement.frame.image.height,
    atlasRect: placement.rect,
    safeArea,
    ...(roundClip ? { roundClip } : {}),
    source: {
      contentHash: placement.frame.contentHash,
      ...(placement.frame.provenance ? { provenance: placement.frame.provenance } : {}),
    },
  }));

  return {
    atlasPng,
    manifest: {
      schemaVersion: 1,
      atlas: {
        id: input.atlasId ?? `${profile.id}.sprites`,
        width: profile.display.width,
        height: atlasHeight,
        pngContentHash: sha256Hex(atlasPng),
      },
      profile: {
        id: profile.id,
        display: {
          width: profile.display.width,
          height: profile.display.height,
          shape: profile.display.shape,
          safeArea,
          ...(roundClip ? { roundClip } : {}),
        },
      },
      frames: manifestFrames,
    },
  };
}

export function decodeRgbaPng(png: Uint8Array): RgbaPngImage {
  const bytes = Buffer.from(png);
  assertPngSignature(bytes);

  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  const idatChunks: Buffer[] = [];
  let sawIend = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("Truncated PNG chunk");
    }

    const chunkLength = bytes.readUInt32BE(offset);
    offset += 4;
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    offset += 4;

    if (offset + chunkLength + 4 > bytes.length) {
      throw new Error(`Truncated PNG ${chunkType} chunk`);
    }

    const chunkData = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength + 4; // Skip data and CRC.

    if (chunkType === "IHDR") {
      if (chunkLength !== 13) {
        throw new Error("Invalid PNG IHDR chunk length");
      }
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      const bitDepth = chunkData[8];
      const colorType = chunkData[9];
      const compression = chunkData[10];
      const filter = chunkData[11];
      const interlace = chunkData[12];

      if (!width || !height) {
        throw new Error("PNG dimensions must be positive");
      }
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error("Only 8-bit RGBA PNG sources are supported");
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("Only non-interlaced PNG sources with standard compression/filtering are supported");
      }
    } else if (chunkType === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      sawIend = true;
      break;
    }
  }

  if (width === undefined || height === undefined) {
    throw new Error("PNG is missing IHDR");
  }
  if (!sawIend) {
    throw new Error("PNG is missing IEND");
  }
  if (idatChunks.length === 0) {
    throw new Error("PNG is missing IDAT data");
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * BYTES_PER_PIXEL;
  const expectedLength = (stride + 1) * height;
  if (inflated.length !== expectedLength) {
    throw new Error(`Unexpected PNG pixel data length ${inflated.length}; expected ${expectedLength}`);
  }

  const rgba = new Uint8Array(width * height * BYTES_PER_PIXEL);
  let inputOffset = 0;
  let outputOffset = 0;
  const previousRow = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[inputOffset];
    inputOffset += 1;
    const row = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const decodedRow = unfilterPngRow(filterType, row, previousRow, BYTES_PER_PIXEL);

    rgba.set(decodedRow, outputOffset);
    previousRow.set(decodedRow);
    outputOffset += stride;
  }

  return { width, height, data: rgba };
}

export function encodeRgbaPng(image: RgbaPngImage): Uint8Array {
  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new Error("PNG width must be a positive integer");
  }
  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new Error("PNG height must be a positive integer");
  }
  const expectedDataLength = image.width * image.height * BYTES_PER_PIXEL;
  if (image.data.length !== expectedDataLength) {
    throw new Error(`RGBA data length ${image.data.length} does not match ${expectedDataLength}`);
  }

  const stride = image.width * BYTES_PER_PIXEL;
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  let inputOffset = 0;
  let outputOffset = 0;
  for (let y = 0; y < image.height; y += 1) {
    scanlines[outputOffset] = 0;
    outputOffset += 1;
    scanlines.set(image.data.subarray(inputOffset, inputOffset + stride), outputOffset);
    inputOffset += stride;
    outputOffset += stride;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", deflateSync(scanlines)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function validateSpriteSheetPackInputShape(input: SpriteSheetPackInput): SpriteValidationIssue[] {
  const issues: SpriteValidationIssue[] = [];
  if (!input.profileId) {
    issues.push({ path: "profileId", message: "Profile ID is required" });
  }
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    issues.push({ path: "frames", message: "At least one source frame is required" });
    return issues;
  }

  for (const [index, frame] of input.frames.entries()) {
    if (!frame.id) {
      issues.push({ path: `frames[${index}].id`, message: "Frame ID is required" });
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(frame.id)) {
      issues.push({
        path: `frames[${index}].id`,
        message: "Frame ID must contain only letters, numbers, dots, underscores, and hyphens",
      });
    }
    if (!isValidFrameKind(frame.kind)) {
      issues.push({
        path: `frames[${index}].kind`,
        message: `Frame kind must be "expression" or "viseme"`,
      });
    }
    if (!(frame.png instanceof Uint8Array) || frame.png.length === 0) {
      issues.push({ path: `frames[${index}].png`, message: "PNG bytes are required" });
    }
    if (frame.expectedWidth !== undefined && (!Number.isInteger(frame.expectedWidth) || frame.expectedWidth <= 0)) {
      issues.push({ path: `frames[${index}].expectedWidth`, message: "Expected width must be positive" });
    }
    if (frame.expectedHeight !== undefined && (!Number.isInteger(frame.expectedHeight) || frame.expectedHeight <= 0)) {
      issues.push({ path: `frames[${index}].expectedHeight`, message: "Expected height must be positive" });
    }
  }

  return issues;
}

function findDuplicateFrameKeys(frames: SpriteSourceFrame[]): Array<{ id: string; kind: SpriteFrameKind }> {
  const seen = new Set<string>();
  const duplicates = new Map<string, { id: string; kind: SpriteFrameKind }>();

  for (const frame of frames) {
    if (!isValidFrameKind(frame.kind)) {
      continue;
    }
    const key = `${frame.kind}:${frame.id}`;
    if (seen.has(key)) {
      duplicates.set(key, { id: frame.id, kind: frame.kind });
    }
    seen.add(key);
  }

  return [...duplicates.values()].sort((left, right) => {
    const kindDelta = SPRITE_KIND_ORDER[left.kind] - SPRITE_KIND_ORDER[right.kind];
    return kindDelta || left.id.localeCompare(right.id);
  });
}

function isValidFrameKind(value: unknown): value is SpriteFrameKind {
  return value === "expression" || value === "viseme";
}

function compareDecodedFrames(left: DecodedSourceFrame, right: DecodedSourceFrame): number {
  const kindDelta = SPRITE_KIND_ORDER[left.kind] - SPRITE_KIND_ORDER[right.kind];
  return kindDelta || left.id.localeCompare(right.id) || left.sourceIndex - right.sourceIndex;
}

function placeFrames(frames: DecodedSourceFrame[], atlasWidth: number): {
  width: number;
  height: number;
  frames: Array<{ frame: DecodedSourceFrame; rect: SpriteAtlasRect }>;
} {
  const placed: Array<{ frame: DecodedSourceFrame; rect: SpriteAtlasRect }> = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const frame of frames) {
    if (cursorX > 0 && cursorX + frame.image.width > atlasWidth) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    const rect = {
      x: cursorX,
      y: cursorY,
      width: frame.image.width,
      height: frame.image.height,
    };
    placed.push({ frame, rect });
    cursorX += frame.image.width;
    rowHeight = Math.max(rowHeight, frame.image.height);
  }

  return {
    width: atlasWidth,
    height: Math.max(1, cursorY + rowHeight),
    frames: placed,
  };
}

function copyFramePixels(source: RgbaPngImage, atlasPixels: Uint8Array, atlasWidth: number, targetX: number, targetY: number): void {
  const sourceStride = source.width * BYTES_PER_PIXEL;
  const atlasStride = atlasWidth * BYTES_PER_PIXEL;

  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * sourceStride;
    const targetStart = ((targetY + y) * atlasStride) + (targetX * BYTES_PER_PIXEL);
    atlasPixels.set(source.data.subarray(sourceStart, sourceStart + sourceStride), targetStart);
  }
}

function makeRoundClip(displayWidth: number, displayHeight: number, safeArea: SpriteSafeAreaMetadata): SpriteRoundClipMetadata {
  return {
    shape: "circle",
    centerX: safeArea.x + safeArea.width / 2,
    centerY: safeArea.y + safeArea.height / 2,
    radius: Math.min(displayWidth, displayHeight, safeArea.width, safeArea.height) / 2,
  };
}

function assertPngSignature(bytes: Buffer): void {
  if (bytes.length < PNG_SIGNATURE.length) {
    throw new Error("PNG data is too short");
  }
  for (const [index, expected] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== expected) {
      throw new Error("Invalid PNG signature");
    }
  }
}

function unfilterPngRow(filterType: number | undefined, row: Uint8Array, previousRow: Uint8Array, bytesPerPixel: number): Uint8Array {
  if (filterType === undefined) {
    throw new Error("Missing PNG row filter");
  }

  const decoded = new Uint8Array(row.length);
  for (let index = 0; index < row.length; index += 1) {
    const raw = row[index] ?? 0;
    const left = index >= bytesPerPixel ? decoded[index - bytesPerPixel] ?? 0 : 0;
    const up = previousRow[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previousRow[index - bytesPerPixel] ?? 0 : 0;

    switch (filterType) {
      case 0:
        decoded[index] = raw;
        break;
      case 1:
        decoded[index] = (raw + left) & 0xff;
        break;
      case 2:
        decoded[index] = (raw + up) & 0xff;
        break;
      case 3:
        decoded[index] = (raw + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        decoded[index] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG row filter ${filterType}`);
    }
  }
  return decoded;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);

  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
    return left;
  }
  if (distanceUp <= distanceUpLeft) {
    return up;
  }
  return upLeft;
}

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const dataBytes = Buffer.from(data);
  const chunk = Buffer.alloc(8 + dataBytes.length + 4);
  chunk.writeUInt32BE(dataBytes.length, 0);
  typeBytes.copy(chunk, 4);
  dataBytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, dataBytes])), 8 + dataBytes.length);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
