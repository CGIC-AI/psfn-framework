import { isObjectRecord } from '../../../../shared/utils/types.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireFrame,
  type VoiceWireInboundFrame,
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

function ensureFrameSize(raw: string, maxFrameBytes: number): void {
  if (maxFrameBytes <= 0) {
    throw new VoiceWireDecodeError('INVALID_FRAME', 'maxFrameBytes must be > 0');
  }
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > maxFrameBytes) {
    throw new VoiceWireDecodeError('FRAME_TOO_LARGE', `Frame is ${byteLength} bytes; limit is ${maxFrameBytes}`);
  }
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
}

export function serializeVoiceWireFrame(frame: VoiceWireFrame): string {
  return JSON.stringify(frame);
}

export function parseVoiceWireFrame(raw: string, maxFrameBytes: number): VoiceWireFrame {
  ensureFrameSize(raw, maxFrameBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new VoiceWireDecodeError('INVALID_JSON', String(error));
  }

  validateShape(parsed);
  return parsed;
}

export function parseInboundVoiceWireFrame(raw: string, maxFrameBytes: number): VoiceWireInboundFrame {
  const frame = parseVoiceWireFrame(raw, maxFrameBytes);
  if (!INBOUND_FRAME_TYPES.has(frame.type as VoiceWireInboundFrame['type'])) {
    throw new VoiceWireDecodeError('NOT_INBOUND', `Inbound frame expected, received ${frame.type}`);
  }
  return frame as VoiceWireInboundFrame;
}
