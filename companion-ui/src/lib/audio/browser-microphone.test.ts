import { describe, expect, it, vi } from 'vitest';
import type { PcmAudioStreamPort } from '../api/pcm-audio.js';
import {
  BrowserMicrophoneCapture,
  describeMicrophoneFailure,
  openBrowserMicrophone,
  ScreenWakeLockController,
  type BrowserMicrophoneEnvironment,
  type BrowserMicrophoneOpener,
} from './browser-microphone.js';
import { COMPANION_PCM_CHUNK_BYTES } from './pcm16-downsampler.js';

function captureFixture() {
  let callbacks: Parameters<BrowserMicrophoneOpener>[0] | undefined;
  const opened = { activate: vi.fn(), close: vi.fn(async () => undefined) };
  const openMicrophone: BrowserMicrophoneOpener = vi.fn(async (next) => {
    callbacks = next;
    return opened;
  });
  const relay: PcmAudioStreamPort = {
    start: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const failures: Error[] = [];
  const capture = new BrowserMicrophoneCapture(relay, {
    openMicrophone,
    onFailure: error => failures.push(error),
  });
  return { capture, relay, openMicrophone, opened, failures, get callbacks() { return callbacks; } };
}

describe('BrowserMicrophoneCapture', () => {
  it('opens only from an explicit start call and activates after gateway readiness', async () => {
    const fixture = captureFixture();
    expect(fixture.openMicrophone).not.toHaveBeenCalled();

    await fixture.capture.startFromUserGesture();

    expect(fixture.openMicrophone).toHaveBeenCalledTimes(1);
    expect(fixture.relay.start).toHaveBeenCalledTimes(1);
    expect(fixture.opened.activate).toHaveBeenCalledTimes(1);
    expect(fixture.capture.isActive()).toBe(true);
  });

  it('forwards bounded PCM sequentially through the authoritative relay', async () => {
    const fixture = captureFixture();
    await fixture.capture.startFromUserGesture();
    const first = new Uint8Array(COMPANION_PCM_CHUNK_BYTES).fill(1);
    const second = new Uint8Array(COMPANION_PCM_CHUNK_BYTES).fill(2);

    fixture.callbacks?.pcm(first);
    fixture.callbacks?.pcm(second);
    await vi.waitFor(() => expect(fixture.relay.write).toHaveBeenCalledTimes(2));

    expect(fixture.relay.write).toHaveBeenNthCalledWith(1, first);
    expect(fixture.relay.write).toHaveBeenNthCalledWith(2, second);
  });

  it('fails loudly to text and closes the gateway stream on permission loss', async () => {
    const fixture = captureFixture();
    await fixture.capture.startFromUserGesture();

    fixture.callbacks?.failed(new Error('Microphone permission was lost'));
    await vi.waitFor(() => expect(fixture.relay.stop).toHaveBeenCalledTimes(1));

    expect(fixture.failures).toHaveLength(1);
    expect(describeMicrophoneFailure(fixture.failures[0])).toMatch(/continue in the text composer/iu);
    expect(fixture.opened.close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed worklet chunks instead of forwarding them', async () => {
    const fixture = captureFixture();
    await fixture.capture.startFromUserGesture();

    fixture.callbacks?.pcm(Uint8Array.of(0, 1));
    await vi.waitFor(() => expect(fixture.failures).toHaveLength(1));

    expect(fixture.relay.write).not.toHaveBeenCalled();
  });

  it('fails closed when acknowledged gateway delivery cannot keep up with capture', async () => {
    let callbacks: Parameters<BrowserMicrophoneOpener>[0] | undefined;
    let releaseWrite: (() => void) | undefined;
    const relay: PcmAudioStreamPort = {
      start: async () => undefined,
      write: vi.fn(() => new Promise<void>(resolve => { releaseWrite = resolve; })),
      stop: vi.fn(async () => undefined),
    };
    const failures: Error[] = [];
    const capture = new BrowserMicrophoneCapture(relay, {
      maxQueuedChunks: 1,
      openMicrophone: async (next) => {
        callbacks = next;
        return { activate() {}, async close() {} };
      },
      onFailure: error => failures.push(error),
    });
    await capture.startFromUserGesture();
    const chunk = new Uint8Array(COMPANION_PCM_CHUNK_BYTES);

    callbacks?.pcm(chunk);
    callbacks?.pcm(chunk);
    callbacks?.pcm(chunk);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    releaseWrite?.();

    expect(failures[0]?.message).toMatch(/backlog/u);
  });
});

describe('openBrowserMicrophone', () => {
  it('unlocks audio and requests a mono microphone before activating the worklet graph', async () => {
    const trackListeners = new Set<() => void>();
    const track = {
      addEventListener: vi.fn((_type: 'ended', listener: () => void) => trackListeners.add(listener)),
      removeEventListener: vi.fn((_type: 'ended', listener: () => void) => trackListeners.delete(listener)),
      stop: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const port: Pick<MessagePort, 'onmessage' | 'onmessageerror'> = {
      onmessage: null,
      onmessageerror: null,
    };
    const worklet = { connect: vi.fn(), disconnect: vi.fn(), port, onprocessorerror: null };
    const context = {
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    const environment: BrowserMicrophoneEnvironment = {
      createAudioContext: () => context,
      createWorkletNode: () => worklet,
      getUserMedia,
      readPermission: async () => null,
    };
    const pcm = vi.fn();
    const failed = vi.fn();

    const microphone = await openBrowserMicrophone({ pcm, failed }, environment);

    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(source.connect).not.toHaveBeenCalled();
    microphone.activate();
    expect(source.connect).toHaveBeenCalledWith(worklet);

    const bytes = new Uint8Array(COMPANION_PCM_CHUNK_BYTES).fill(7);
    port.onmessage?.call(
      port as MessagePort,
      { data: { type: 'pcm', pcm: bytes.buffer } } as MessageEvent,
    );
    expect(pcm).toHaveBeenCalledWith(bytes);
    for (const listener of trackListeners) listener();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/access was lost/u) }));

    await microphone.close();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

describe('ScreenWakeLockController', () => {
  it('holds one screen lock for hands-free capture and releases it on exit', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release }));
    const wakeLock = new ScreenWakeLockController(request);

    await wakeLock.acquire();
    await wakeLock.acquire();
    await wakeLock.release();

    expect(request).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
