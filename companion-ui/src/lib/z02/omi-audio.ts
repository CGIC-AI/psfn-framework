export const OMI_OPUS_CODEC_ID = 0x15;
export const OMI_AUDIO_HEADER_BYTES = 3;

const MAX_OPUS_FRAME_BYTES = 1_275;

export type OmiAudioPacket = Readonly<{
  sequence: number;
  subpacket: number;
  payload: Uint8Array;
}>;

export type OmiOpusFrame = Readonly<{
  firstSequence: number;
  lastSequence: number;
  opus: Uint8Array;
}>;

export function parseOmiAudioPacket(value: Uint8Array): OmiAudioPacket {
  if (value.byteLength < OMI_AUDIO_HEADER_BYTES + 1) {
    throw new Error('Omi audio packet has no Opus payload');
  }
  return {
    sequence: value[0]! | (value[1]! << 8),
    subpacket: value[2]!,
    payload: value.slice(OMI_AUDIO_HEADER_BYTES),
  };
}

/**
 * Reassembles Omi's BLE packet stream into complete Opus frames.
 *
 * A sub-packet id of zero starts a new Opus frame. The next zero therefore
 * closes the previous frame; non-zero ids continue it. Sequence or sub-packet
 * gaps discard the pending frame so corrupt audio never reaches a decoder.
 */
export class OmiOpusFrameAssembler {
  private pending: number[] = [];
  private firstSequence: number | null = null;
  private lastSequence: number | null = null;
  private lastSubpacket = 0;
  private dropped = 0;

  get droppedFrames(): number {
    return this.dropped;
  }

  push(value: Uint8Array): OmiOpusFrame[] {
    const packet = parseOmiAudioPacket(value);
    if (this.firstSequence === null) {
      if (packet.subpacket === 0) this.start(packet);
      return [];
    }

    const expectedSequence = ((this.lastSequence ?? 0) + 1) & 0xffff;
    const sequenceMatches = packet.sequence === expectedSequence;
    const subpacketMatches = packet.subpacket === 0
      || packet.subpacket === this.lastSubpacket + 1;
    if (!sequenceMatches || !subpacketMatches) {
      this.dropPending();
      if (packet.subpacket === 0) this.start(packet);
      return [];
    }

    if (packet.subpacket === 0) {
      const completed = this.complete();
      this.start(packet);
      return completed ? [completed] : [];
    }

    if (this.pending.length + packet.payload.byteLength > MAX_OPUS_FRAME_BYTES) {
      this.dropPending();
      return [];
    }
    this.pending.push(...packet.payload);
    this.lastSequence = packet.sequence;
    this.lastSubpacket = packet.subpacket;
    return [];
  }

  flush(): OmiOpusFrame[] {
    const completed = this.complete();
    return completed ? [completed] : [];
  }

  reset(): void {
    this.pending = [];
    this.firstSequence = null;
    this.lastSequence = null;
    this.lastSubpacket = 0;
  }

  private start(packet: OmiAudioPacket): void {
    this.pending = [...packet.payload];
    this.firstSequence = packet.sequence;
    this.lastSequence = packet.sequence;
    this.lastSubpacket = 0;
  }

  private complete(): OmiOpusFrame | null {
    if (this.firstSequence === null || this.lastSequence === null || this.pending.length === 0) {
      this.reset();
      return null;
    }
    const frame = {
      firstSequence: this.firstSequence,
      lastSequence: this.lastSequence,
      opus: Uint8Array.from(this.pending),
    };
    this.reset();
    return frame;
  }

  private dropPending(): void {
    if (this.firstSequence !== null) this.dropped += 1;
    this.reset();
  }
}
