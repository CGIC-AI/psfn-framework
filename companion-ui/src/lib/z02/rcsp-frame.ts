const RCSP_HEADER = Uint8Array.of(0xfe, 0xdc, 0xba);
const RCSP_TRAILER = 0xef;
const RCSP_ENVELOPE_BYTES = 8;
const MAX_RCSP_PAYLOAD_BYTES = 0xffff;

export interface RcspCommandFrame {
  readonly kind: 'command';
  readonly flags: number;
  readonly opcode: number;
  readonly needsResponse: boolean;
  readonly sequence: number;
  readonly data: Uint8Array;
}

export interface RcspResponseFrame {
  readonly kind: 'response';
  readonly flags: number;
  readonly opcode: number;
  readonly status: number;
  readonly sequence: number;
  readonly data: Uint8Array;
}

export type RcspFrame = RcspCommandFrame | RcspResponseFrame;

export function encodeRcspCommand(
  opcode: number,
  sequence: number,
  data: Uint8Array = new Uint8Array(),
  needsResponse = true,
): Uint8Array {
  requireByte(opcode, 'opcode');
  requireByte(sequence, 'sequence');
  if (data.byteLength > MAX_RCSP_PAYLOAD_BYTES - 1) {
    throw new Error('RCSP command payload is too large');
  }
  const payloadLength = data.byteLength + 1;
  const result = new Uint8Array(payloadLength + RCSP_ENVELOPE_BYTES);
  result.set(RCSP_HEADER, 0);
  result[3] = needsResponse ? 0xc0 : 0x80;
  result[4] = opcode;
  result[5] = payloadLength >>> 8;
  result[6] = payloadLength & 0xff;
  result[7] = sequence;
  result.set(data, 8);
  result[result.length - 1] = RCSP_TRAILER;
  return result;
}

/** Reassembles RCSP envelopes split or coalesced by the BLE ATT transport. */
export class RcspStreamDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(fragment: Uint8Array): RcspFrame[] {
    if (fragment.byteLength === 0) return [];
    this.buffer = concat(this.buffer, fragment);
    const decoded: RcspFrame[] = [];

    while (this.buffer.byteLength >= RCSP_HEADER.byteLength) {
      const headerOffset = findHeader(this.buffer);
      if (headerOffset < 0) {
        this.buffer = possibleHeaderSuffix(this.buffer);
        break;
      }
      if (headerOffset > 0) this.buffer = this.buffer.slice(headerOffset);
      if (this.buffer.byteLength < RCSP_ENVELOPE_BYTES) break;

      const payloadLength = (byteAt(this.buffer, 5) << 8) | byteAt(this.buffer, 6);
      const frameLength = payloadLength + RCSP_ENVELOPE_BYTES;
      if (this.buffer.byteLength < frameLength) break;
      if (byteAt(this.buffer, frameLength - 1) !== RCSP_TRAILER) {
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const flags = byteAt(this.buffer, 3);
      const opcode = byteAt(this.buffer, 4);
      const payload = this.buffer.slice(7, frameLength - 1);
      this.buffer = this.buffer.slice(frameLength);
      if ((flags & 0x80) !== 0) {
        if (payload.byteLength < 1) continue;
        decoded.push({
          kind: 'command',
          flags,
          opcode,
          needsResponse: (flags & 0x40) !== 0,
          sequence: byteAt(payload, 0),
          data: payload.slice(1),
        });
        continue;
      }
      if (payload.byteLength < 2) continue;
      decoded.push({
        kind: 'response',
        flags,
        opcode,
        status: byteAt(payload, 0),
        sequence: byteAt(payload, 1),
        data: payload.slice(2),
      });
    }
    return decoded;
  }

  reset(): void {
    this.buffer = new Uint8Array();
  }
}

function findHeader(value: Uint8Array): number {
  for (let index = 0; index <= value.byteLength - RCSP_HEADER.byteLength; index += 1) {
    if (byteAt(value, index) === RCSP_HEADER[0]
      && byteAt(value, index + 1) === RCSP_HEADER[1]
      && byteAt(value, index + 2) === RCSP_HEADER[2]) return index;
  }
  return -1;
}

function possibleHeaderSuffix(value: Uint8Array): Uint8Array {
  if (value.byteLength >= 2
    && byteAt(value, value.byteLength - 2) === RCSP_HEADER[0]
    && byteAt(value, value.byteLength - 1) === RCSP_HEADER[1]) return value.slice(-2);
  if (byteAt(value, value.byteLength - 1) === RCSP_HEADER[0]) return value.slice(-1);
  return new Uint8Array();
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first, 0);
  result.set(second, first.byteLength);
  return result;
}

function byteAt(value: Uint8Array, index: number): number {
  const result = value[index];
  if (result === undefined) throw new Error('RCSP frame index is out of bounds');
  return result;
}

function requireByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`RCSP ${name} must fit in one byte`);
  }
}
