import workletModuleUrl from './pcm16-capture-worklet.ts?worker&url';
import type { PcmAudioStreamPort } from '../api/pcm-audio.js';
import {
  COMPANION_PCM_CHUNK_BYTES,
  COMPANION_PCM_SAMPLE_RATE_HZ,
  COMPANION_PCM_WORKLET_NAME,
} from './pcm16-downsampler.js';

const MAX_QUEUED_PCM_CHUNKS = 8;

interface MicrophoneTrackLike {
  addEventListener(type: 'ended', listener: () => void): void;
  removeEventListener(type: 'ended', listener: () => void): void;
  stop(): void;
}

interface MicrophoneStreamLike {
  getTracks(): MicrophoneTrackLike[];
}

interface CaptureAudioNodeLike {
  connect(node: CaptureAudioNodeLike): unknown;
  disconnect(): void;
}

interface CaptureWorkletNodeLike extends CaptureAudioNodeLike {
  readonly port: Pick<MessagePort, 'onmessage' | 'onmessageerror'>;
  onprocessorerror: ((event: ErrorEvent) => void) | null;
}

interface CaptureAudioContextLike {
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  readonly sampleRate: number;
  createMediaStreamSource(stream: MicrophoneStreamLike): CaptureAudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface MicrophonePermissionStatusLike {
  readonly state: PermissionState;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface BrowserMicrophoneEnvironment {
  createAudioContext(): CaptureAudioContextLike;
  createWorkletNode(context: CaptureAudioContextLike): CaptureWorkletNodeLike;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MicrophoneStreamLike>;
  readPermission(): Promise<MicrophonePermissionStatusLike | null>;
}

interface OpenMicrophoneOptions {
  readonly pcm: (chunk: Uint8Array) => void;
  readonly failed: (error: Error) => void;
}

export interface OpenBrowserMicrophone {
  activate(): void;
  close(): Promise<void>;
}

export type BrowserMicrophoneOpener = (
  options: OpenMicrophoneOptions,
) => Promise<OpenBrowserMicrophone>;

export class BrowserMicrophoneCapture {
  private phase: 'idle' | 'starting' | 'active' | 'stopping' = 'idle';
  private opened: OpenBrowserMicrophone | null = null;
  private relayStarted = false;
  private readonly queued: Uint8Array[] = [];
  private pumpTask: Promise<void> | null = null;
  private failureReported = false;

  constructor(
    private readonly relay: PcmAudioStreamPort,
    private readonly options: {
      readonly openMicrophone?: BrowserMicrophoneOpener;
      readonly onFailure: (error: Error) => void;
      readonly maxQueuedChunks?: number;
    },
  ) {}

  isActive(): boolean {
    return this.phase === 'active';
  }

  async startFromUserGesture(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('Browser microphone capture is already active');
    this.phase = 'starting';
    this.failureReported = false;
    const openMicrophone = this.options.openMicrophone ?? openBrowserMicrophone;
    try {
      const opened = await openMicrophone({
        pcm: chunk => this.receivePcm(chunk),
        failed: error => this.fail(error),
      });
      this.opened = opened;
      await this.relay.start();
      this.relayStarted = true;
      if (this.phase !== 'starting') {
        await this.teardown();
        return;
      }
      opened.activate();
      this.phase = 'active';
    } catch (error) {
      const resolved = microphoneError(error);
      await this.teardown();
      this.phase = 'idle';
      throw resolved;
    }
  }

  async stop(): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    this.phase = 'stopping';
    await this.teardown();
    this.phase = 'idle';
  }

  private receivePcm(chunk: Uint8Array): void {
    if (this.phase !== 'active') return;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength !== COMPANION_PCM_CHUNK_BYTES) {
      this.fail(new Error('Browser microphone produced a malformed PCM chunk'));
      return;
    }
    const maxQueuedChunks = this.options.maxQueuedChunks ?? MAX_QUEUED_PCM_CHUNKS;
    if (this.queued.length >= maxQueuedChunks) {
      this.fail(new Error('Browser microphone relay backlog was exceeded'));
      return;
    }
    this.queued.push(chunk.slice());
    this.pumpTask ??= this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.phase === 'active' && this.queued.length > 0) {
        const chunk = this.queued.shift();
        if (chunk) await this.relay.write(chunk);
      }
    } catch (error) {
      this.fail(microphoneError(error));
    } finally {
      this.pumpTask = null;
      if (this.phase === 'active' && this.queued.length > 0) {
        this.pumpTask = this.pump();
      }
    }
  }

  private fail(error: Error): void {
    if (this.phase === 'idle' || this.phase === 'stopping') return;
    if (!this.failureReported) {
      this.failureReported = true;
      this.options.onFailure(error);
    }
    void this.stop();
  }

  private async teardown(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    this.queued.length = 0;
    await opened?.close().catch(() => undefined);
    await this.pumpTask?.catch(() => undefined);
    if (this.relayStarted) {
      this.relayStarted = false;
      await this.relay.stop();
    }
  }
}

export async function openBrowserMicrophone(
  options: OpenMicrophoneOptions,
  environment = readBrowserMicrophoneEnvironment(),
): Promise<OpenBrowserMicrophone> {
  if (!environment) throw new Error('This browser does not support microphone AudioWorklets');
  const context = environment.createAudioContext();
  const resumeTask = context.resume();
  const mediaTask = environment.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const [resumeResult, mediaResult] = await Promise.allSettled([resumeTask, mediaTask]);
  if (resumeResult.status === 'rejected' || mediaResult.status === 'rejected') {
    if (mediaResult.status === 'fulfilled') {
      for (const track of mediaResult.value.getTracks()) track.stop();
    }
    await context.close().catch(() => undefined);
    if (resumeResult.status === 'rejected') throw resumeResult.reason;
    if (mediaResult.status === 'rejected') throw mediaResult.reason;
    throw new Error('Microphone startup failed');
  }
  const stream = mediaResult.value;
  if (context.sampleRate < COMPANION_PCM_SAMPLE_RATE_HZ) {
    for (const track of stream.getTracks()) track.stop();
    await context.close();
    throw new Error('Microphone sample rate is below the required 16 kHz PCM rate');
  }
  try {
    await context.audioWorklet.addModule(workletModuleUrl);
    const source = context.createMediaStreamSource(stream);
    const worklet = environment.createWorkletNode(context);
    let active = false;
    let closed = false;
    const permission = await environment.readPermission().catch(() => null);
    const permissionChanged = () => {
      if (permission?.state === 'denied') {
        options.failed(new Error('Microphone permission was lost'));
      }
    };
    const trackEnded = () => options.failed(new Error('Microphone permission or device access was lost'));
    for (const track of stream.getTracks()) track.addEventListener('ended', trackEnded);
    permission?.addEventListener('change', permissionChanged);
    worklet.onprocessorerror = () => options.failed(new Error('Microphone AudioWorklet failed'));
    worklet.port.onmessageerror = () => options.failed(new Error('Microphone AudioWorklet returned an unreadable chunk'));
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!active || !isPcmWorkletMessage(event.data)) return;
      options.pcm(new Uint8Array(event.data.pcm));
    };

    return {
      activate() {
        if (closed || active) return;
        active = true;
        source.connect(worklet);
      },
      async close() {
        if (closed) return;
        closed = true;
        active = false;
        permission?.removeEventListener('change', permissionChanged);
        worklet.port.onmessage = null;
        worklet.port.onmessageerror = null;
        worklet.onprocessorerror = null;
        source.disconnect();
        worklet.disconnect();
        for (const track of stream.getTracks()) {
          track.removeEventListener('ended', trackEnded);
          track.stop();
        }
        await context.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => undefined);
    throw error;
  }
}

export function browserMicrophoneSupported(): boolean {
  return readBrowserMicrophoneEnvironment() !== null;
}

export function describeMicrophoneFailure(error: unknown): string {
  const resolved = microphoneError(error);
  if (resolved.name === 'NotAllowedError' || /permission|access was lost/iu.test(resolved.message)) {
    return 'Microphone permission was denied or lost. Voice capture stopped; continue in the text composer.';
  }
  return `Microphone capture stopped: ${resolved.message}. Continue in the text composer.`;
}

export interface ScreenWakeLockSentinelLike {
  release(): Promise<void>;
}

export class ScreenWakeLockController {
  private sentinel: ScreenWakeLockSentinelLike | null = null;

  constructor(
    private readonly request: (() => Promise<ScreenWakeLockSentinelLike>) | null = readWakeLockRequest(),
  ) {}

  supported(): boolean {
    return this.request !== null;
  }

  async acquire(): Promise<void> {
    if (this.sentinel || !this.request) {
      if (!this.request) throw new Error('Screen wake lock is unavailable');
      return;
    }
    this.sentinel = await this.request();
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    await sentinel?.release();
  }
}

function readBrowserMicrophoneEnvironment(): BrowserMicrophoneEnvironment | null {
  const globalWithWebkit = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = globalThis.AudioContext ?? globalWithWebkit.webkitAudioContext;
  if (!AudioContextConstructor || !navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) {
    return null;
  }
  return {
    createAudioContext: () => new AudioContextConstructor({ latencyHint: 'interactive' }),
    createWorkletNode: context => new AudioWorkletNode(
      context as AudioContext,
      COMPANION_PCM_WORKLET_NAME,
      { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 },
    ),
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    readPermission: async () => {
      if (!navigator.permissions?.query) return null;
      return navigator.permissions.query({ name: 'microphone' as PermissionName });
    },
  };
}

function readWakeLockRequest(): (() => Promise<ScreenWakeLockSentinelLike>) | null {
  const wakeLock = navigator.wakeLock;
  return wakeLock?.request
    ? () => wakeLock.request('screen')
    : null;
}

function isPcmWorkletMessage(value: unknown): value is { type: 'pcm'; pcm: ArrayBuffer } {
  return typeof value === 'object' && value !== null
    && Object.keys(value).length === 2
    && (value as { type?: unknown }).type === 'pcm'
    && (value as { pcm?: unknown }).pcm instanceof ArrayBuffer;
}

function microphoneError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
