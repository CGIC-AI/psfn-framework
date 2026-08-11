import { isObjectRecord as isRecord } from '../utils/types.js';

const AUDIO_CHUNK_MAGIC = Uint8Array.of(0x50, 0x53, 0x5a, 0x41); // PSZA
const AUDIO_CHUNK_VERSION = 1;
const AUDIO_CHUNK_HEADER_BYTES = 9;
const MAX_SEQUENCE = 0xffff_ffff;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type CompanionUiAudioControlFrame = Readonly<{
  schemaVersion: 1;
  type: 'audio.start' | 'audio.interrupt' | 'audio.stop';
  requestId: string;
}>;

export type CompanionUiAudioServerFrame = Readonly<{
  schemaVersion: 1;
  type: 'audio.ready' | 'audio.turn.started' | 'audio.turn.ended' | 'audio.stopped';
  requestId: string;
}> | Readonly<{
  schemaVersion: 1;
  type: 'audio.ack';
  requestId: string;
  sequence: number;
}>;

export type CompanionUiAudioChunk = Readonly<{
  sequence: number;
  pcm: Uint8Array;
}>;

export class CompanionUiAudioProtocolError extends Error {
  constructor(message = 'Companion UI audio frame was malformed') {
    super(message);
    this.name = 'CompanionUiAudioProtocolError';
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function parseJson(raw: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : textDecoder.decode(raw)) as unknown;
  } catch {
    throw new CompanionUiAudioProtocolError();
  }
}

export function parseCompanionUiAudioControlFrame(
  raw: string | Uint8Array,
): CompanionUiAudioControlFrame {
  const value = parseJson(raw);
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'type', 'requestId'])
    || value.schemaVersion !== 1
    || !['audio.start', 'audio.interrupt', 'audio.stop'].includes(String(value.type))
    || !validRequestId(value.requestId)) {
    throw new CompanionUiAudioProtocolError();
  }
  return Object.freeze({
    schemaVersion: 1,
    type: value.type as CompanionUiAudioControlFrame['type'],
    requestId: value.requestId,
  });
}

export function encodeCompanionUiAudioChunk(sequence: number, pcm: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE
    || !(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new CompanionUiAudioProtocolError();
  }
  const frame = new Uint8Array(AUDIO_CHUNK_HEADER_BYTES + pcm.byteLength);
  frame.set(AUDIO_CHUNK_MAGIC, 0);
  frame[AUDIO_CHUNK_MAGIC.byteLength] = AUDIO_CHUNK_VERSION;
  new DataView(frame.buffer).setUint32(AUDIO_CHUNK_MAGIC.byteLength + 1, sequence, false);
  frame.set(pcm, AUDIO_CHUNK_HEADER_BYTES);
  return frame;
}

export function parseCompanionUiAudioChunk(raw: Uint8Array): CompanionUiAudioChunk {
  if (!(raw instanceof Uint8Array)
    || raw.byteLength <= AUDIO_CHUNK_HEADER_BYTES
    || (raw.byteLength - AUDIO_CHUNK_HEADER_BYTES) % 2 !== 0
    || raw[AUDIO_CHUNK_MAGIC.byteLength] !== AUDIO_CHUNK_VERSION
    || AUDIO_CHUNK_MAGIC.some((byte, index) => raw[index] !== byte)) {
    throw new CompanionUiAudioProtocolError();
  }
  const sequence = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    .getUint32(AUDIO_CHUNK_MAGIC.byteLength + 1, false);
  return Object.freeze({
    sequence,
    pcm: raw.slice(AUDIO_CHUNK_HEADER_BYTES),
  });
}

export function parseCompanionUiAudioServerFrame(
  value: unknown,
): CompanionUiAudioServerFrame | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !validRequestId(value.requestId)) {
    return undefined;
  }
  if (['audio.ready', 'audio.turn.started', 'audio.turn.ended', 'audio.stopped']
    .includes(String(value.type))
    && hasExactKeys(value, ['schemaVersion', 'type', 'requestId'])) {
    return Object.freeze({
      schemaVersion: 1,
      type: value.type as Extract<CompanionUiAudioServerFrame, { sequence?: never }>['type'],
      requestId: value.requestId,
    });
  }
  if (value.type === 'audio.ack'
    && hasExactKeys(value, ['schemaVersion', 'type', 'requestId', 'sequence'])
    && Number.isSafeInteger(value.sequence)
    && Number(value.sequence) >= 0
    && Number(value.sequence) <= MAX_SEQUENCE) {
    return Object.freeze({
      schemaVersion: 1,
      type: 'audio.ack',
      requestId: value.requestId,
      sequence: Number(value.sequence),
    });
  }
  return undefined;
}
