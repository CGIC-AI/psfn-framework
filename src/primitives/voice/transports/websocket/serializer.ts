import { isObjectRecord } from '../../../../shared/utils/types.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireFrame,
  type VoiceWireInboundFrame,
  type VoiceWireTransportData,
} from './types.js';

export class VoiceWireDecodeError extends Error {
  readonly code: 'FRAME_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_FRAME' | 'NOT_INBOUND';

  constructor(code: VoiceWireDecodeError['code'], message: string) {
    super(message);
    this.name = 'VoiceWireDecodeError';
    this.code = code;
  }
}

const INBOUND_FRAME_TYPES = new Set<VoiceWireInboundFrame['type']>([
  'session.start',
  'audio.chunk',
  'session.end',
  'interrupt',
  'ping',
]);

const BINARY_MAGIC = Buffer.from('PSVB', 'ascii');
const BINARY_HEADER_BYTES = 20;
const BINARY_FORMAT_VERSION = 1;
const BINARY_KIND_AUDIO_CHUNK = 1;
const BINARY_KIND_PLAYBACK_CHUNK = 2;
const MAX_UINT32 = 0xffff_ffff;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function ensureFrameSize(raw: VoiceWireTransportData, maxFrameBytes: number): void {
  if (maxFrameBytes <= 0) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'maxFrameBytes must be > 0');
  }
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (byteLength > maxFrameBytes) {
    throw new VoiceWireDecodeError('FRAME_TOO_LARGE', `Frame is ${byteLength} bytes; limit is ${maxFrameBytes}`);
  }
}

function requireValidSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Audio frame seq must be an unsigned 32-bit integer');
  }
}

function encodeBinaryAudioFrame(
  frame: Extract<VoiceWireFrame, { type: 'audio.chunk' | 'playback.chunk' }>,
): Uint8Array {
  requireValidSequence(frame.seq);
  if (!(frame.audio instanceof Uint8Array) || frame.audio.byteLength === 0) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Audio frame payload must be non-empty bytes');
  }
  const sessionId = Buffer.from(frame.sessionId, 'utf8');
  if (sessionId.byteLength === 0 || sessionId.byteLength > 0xffff) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Audio frame sessionId byte length is invalid');
  }
  if (
    frame.timestampMs !== undefined
    && (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0)
  ) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Audio frame timestampMs must be a non-negative finite number');
  }

  const output = Buffer.allocUnsafe(BINARY_HEADER_BYTES + sessionId.byteLength + frame.audio.byteLength);
  BINARY_MAGIC.copy(output, 0);
  output.writeUInt8(BINARY_FORMAT_VERSION, 4);
  output.writeUInt8(frame.type === 'audio.chunk' ? BINARY_KIND_AUDIO_CHUNK : BINARY_KIND_PLAYBACK_CHUNK, 5);
  output.writeUInt16BE(sessionId.byteLength, 6);
  output.writeUInt32BE(frame.seq, 8);
  output.writeDoubleBE(frame.timestampMs ?? Number.NaN, 12);
  sessionId.copy(output, BINARY_HEADER_BYTES);
  Buffer.from(frame.audio).copy(output, BINARY_HEADER_BYTES + sessionId.byteLength);
  return output;
}

function decodeBinaryAudioFrame(raw: Uint8Array): VoiceWireFrame {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.byteLength < BINARY_HEADER_BYTES || !bytes.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Malformed binary voice frame header');
  }
  if (bytes.readUInt8(4) !== BINARY_FORMAT_VERSION) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Unsupported binary voice frame version');
  }
  const kind = bytes.readUInt8(5);
  if (kind !== BINARY_KIND_AUDIO_CHUNK && kind !== BINARY_KIND_PLAYBACK_CHUNK) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Unsupported binary voice frame kind');
  }
  const sessionIdBytes = bytes.readUInt16BE(6);
  const payloadOffset = BINARY_HEADER_BYTES + sessionIdBytes;
  if (sessionIdBytes === 0 || payloadOffset >= bytes.byteLength) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Binary voice frame session or audio payload is empty');
  }
  let sessionId: string;
  try {
    sessionId = utf8Decoder.decode(bytes.subarray(BINARY_HEADER_BYTES, payloadOffset));
  } catch (error) {
    throw new VoiceWireDecodeError('INVALID_FRAME', `Binary voice frame sessionId is not UTF-8: ${String(error)}`);
  }
  if (!sessionId) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Binary voice frame sessionId is required');
  }
  const timestampMs = bytes.readDoubleBE(12);
  if (!Number.isNaN(timestampMs) && (!Number.isFinite(timestampMs) || timestampMs < 0)) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Binary voice frame timestamp is invalid');
  }
  const base = {
    wire: VOICE_WIRE_PROTOCOL,
    sessionId,
    seq: bytes.readUInt32BE(8),
    ...(!Number.isNaN(timestampMs) ? { timestampMs } : {}),
    audio: new Uint8Array(bytes.subarray(payloadOffset)),
  };
  return kind === BINARY_KIND_AUDIO_CHUNK
    ? { ...base, type: 'audio.chunk' }
    : { ...base, type: 'playback.chunk' };
}

function validateShape(value: unknown): asserts value is VoiceWireFrame {
  if (!isObjectRecord(value)) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Frame must be an object');
  }
  if (value.wire !== VOICE_WIRE_PROTOCOL) {
    throw new VoiceWireDecodeError('INVALID_FRAME', `Unsupported wire protocol: ${String(value.wire)}`);
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'Frame type is required');
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'sessionId is required');
  }
  if (value.type === 'audio.chunk' || value.type === 'playback.chunk') {
    throw new VoiceWireDecodeError('INVALID_FRAME', `${value.type} must use binary WebSocket framing`);
  }
}

export function serializeVoiceWireFrame(frame: VoiceWireFrame): VoiceWireTransportData {
  if (frame.type === 'audio.chunk' || frame.type === 'playback.chunk') {
    return encodeBinaryAudioFrame(frame);
  }
  return JSON.stringify(frame);
}

export function parseVoiceWireFrame(raw: VoiceWireTransportData, maxFrameBytes: number): VoiceWireFrame {
  ensureFrameSize(raw, maxFrameBytes);

  if (raw instanceof Uint8Array) {
    return decodeBinaryAudioFrame(raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new VoiceWireDecodeError('INVALID_JSON', String(error));
  }

  validateShape(parsed);
  return parsed;
}

export function parseInboundVoiceWireFrame(
  raw: VoiceWireTransportData,
  maxFrameBytes: number,
): VoiceWireInboundFrame {
  const frame = parseVoiceWireFrame(raw, maxFrameBytes);
  if (!INBOUND_FRAME_TYPES.has(frame.type as VoiceWireInboundFrame['type'])) {
    throw new VoiceWireDecodeError('NOT_INBOUND', `Inbound frame expected, received ${frame.type}`);
  }
  return frame as VoiceWireInboundFrame;
}
