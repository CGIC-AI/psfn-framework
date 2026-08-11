const OMI_SAMPLE_RATE_HZ = 16_000;
const OMI_CHANNELS = 1;
const OMI_FRAME_DURATION_US = 20_000;
const OMI_MAX_OPUS_FRAME_BYTES = 1_275;

type OmiPcmFrame = Readonly<{
  pcm: Uint8Array;
  sampleRateHz: 16_000;
  channels: 1;
  timestampUs: number;
}>;

export interface OmiOpusDecoderCallbacks {
  pcm(frame: OmiPcmFrame): void;
  error(error: Error): void;
}

export interface OmiWebCodecsAudioData {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  allocationSize(options: { planeIndex: number; format: 's16' }): number;
  copyTo(destination: Uint8Array, options: { planeIndex: number; format: 's16' }): Promise<void>;
  close(): void;
}

export interface OmiWebCodecsDecoder {
  state: 'unconfigured' | 'configured' | 'closed';
  configure(config: { codec: 'opus'; sampleRate: 16_000; numberOfChannels: 1 }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}

export interface OmiWebCodecs {
  createDecoder(init: {
    output: (data: OmiWebCodecsAudioData) => void;
    error: (error: DOMException) => void;
  }): OmiWebCodecsDecoder;
  createEncodedChunk(init: {
    type: 'key';
    timestamp: number;
    duration: 20_000;
    data: Uint8Array;
  }): unknown;
}

/** Decode Stark Ruby's Omi codec-21 frames into the Hub's PCM input format. */
export class WebCodecsOmiOpusDecoder {
  private readonly decoder: OmiWebCodecsDecoder;
  private readonly pendingTimestamps: number[] = [];
  private nextTimestampUs = 0;
  private closed = false;

  constructor(
    private readonly callbacks: OmiOpusDecoderCallbacks,
    private readonly codecs: OmiWebCodecs = readBrowserWebCodecs(),
  ) {
    this.decoder = codecs.createDecoder({
      output: data => { void this.consume(data); },
      error: error => this.fail(error),
    });
    this.decoder.configure({
      codec: 'opus',
      numberOfChannels: OMI_CHANNELS,
      sampleRate: OMI_SAMPLE_RATE_HZ,
    });
  }

  decode(opus: Uint8Array): void {
    if (this.closed) throw new Error('Omi Opus decoder is closed');
    if (opus.byteLength === 0 || opus.byteLength > OMI_MAX_OPUS_FRAME_BYTES) {
      throw new Error('Omi Opus frame has an invalid size');
    }
    const timestamp = this.nextTimestampUs;
    this.nextTimestampUs += OMI_FRAME_DURATION_US;
    this.pendingTimestamps.push(timestamp);
    try {
      this.decoder.decode(this.codecs.createEncodedChunk({
        type: 'key',
        timestamp,
        duration: OMI_FRAME_DURATION_US,
        data: opus.slice(),
      }));
    } catch (error) {
      this.pendingTimestamps.pop();
      throw error;
    }
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.decoder.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingTimestamps.length = 0;
    if (this.decoder.state !== 'closed') this.decoder.close();
  }

  private async consume(data: OmiWebCodecsAudioData): Promise<void> {
    const timestampUs = this.pendingTimestamps.shift();
    try {
      if (this.closed || timestampUs === undefined) return;
      if (data.sampleRate !== OMI_SAMPLE_RATE_HZ || data.numberOfChannels !== OMI_CHANNELS) {
        throw new Error(
          `Omi decoder produced ${data.sampleRate} Hz / ${data.numberOfChannels} channel audio`,
        );
      }
      const options = { planeIndex: 0, format: 's16' as const };
      const pcm = new Uint8Array(data.allocationSize(options));
      await data.copyTo(pcm, options);
      if (!this.closed) {
        this.callbacks.pcm({
          pcm,
          sampleRateHz: OMI_SAMPLE_RATE_HZ,
          channels: OMI_CHANNELS,
          timestampUs,
        });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      data.close();
    }
  }

  private fail(error: unknown): void {
    this.callbacks.error(error instanceof Error ? error : new Error(String(error)));
  }
}

function readBrowserWebCodecs(): OmiWebCodecs {
  const browser = globalThis as Record<string, unknown>;
  const Decoder = browser.AudioDecoder as (new (init: {
    output: (data: OmiWebCodecsAudioData) => void;
    error: (error: DOMException) => void;
  }) => OmiWebCodecsDecoder) | undefined;
  const Chunk = browser.EncodedAudioChunk as (new (init: {
    type: 'key';
    timestamp: number;
    duration: 20_000;
    data: Uint8Array;
  }) => unknown) | undefined;
  if (!Decoder || !Chunk) {
    throw new Error('This browser cannot decode the Z02 Omi Opus stream');
  }
  return {
    createDecoder: init => new Decoder(init),
    createEncodedChunk: init => new Chunk(init),
  };
}
