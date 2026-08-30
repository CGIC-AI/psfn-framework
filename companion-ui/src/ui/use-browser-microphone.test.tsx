import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PcmAudioStreamPort } from '../lib/api/pcm-audio.js';
import {
  shouldInterruptForMicrophoneSpeech,
  useBrowserMicrophone,
} from './use-browser-microphone.js';

const relay: PcmAudioStreamPort = {
  start: async () => undefined,
  write: async () => undefined,
  stop: async () => undefined,
};

describe('useBrowserMicrophone', () => {
  it('acquires and releases a wake lock with avatar hands-free capture', async () => {
    const capture = {
      startFromUserGesture: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const wakeLock = {
      supported: () => true,
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const { result } = renderHook(() => useBrowserMicrophone(relay, {
      supported: true,
      createCapture: () => capture,
      createWakeLock: () => wakeLock,
    }));

    await act(() => result.current.startFromUserGesture({ handsFree: true }));
    expect(result.current.state).toMatchObject({
      phase: 'active', handsFree: true, wakeLockHeld: true,
    });
    expect(wakeLock.acquire).toHaveBeenCalledTimes(1);

    await act(() => result.current.stop());
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('idle');
  });

  it('surfaces permission loss as a loud text-composer fallback', async () => {
    let fail: ((error: Error) => void) | undefined;
    const capture = {
      startFromUserGesture: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const { result } = renderHook(() => useBrowserMicrophone(relay, {
      supported: true,
      createCapture: onFailure => {
        fail = onFailure;
        return capture;
      },
    }));
    await act(() => result.current.startFromUserGesture());

    act(() => fail?.(new Error('Microphone permission was lost')));

    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.detail).toMatch(/continue in the text composer/iu);
  });

  it('stays inert when AudioWorklet microphone capture is unsupported', async () => {
    const createCapture = vi.fn();
    const { result } = renderHook(() => useBrowserMicrophone(relay, {
      supported: false,
      createCapture,
    }));

    await act(() => result.current.startFromUserGesture({ handsFree: true }));

    expect(createCapture).not.toHaveBeenCalled();
    expect(result.current.state.detail).toMatch(/text composer/iu);
  });
});

describe('microphone speech interruption', () => {
  it('interrupts once when hands-free partial speech overlaps a companion reply', () => {
    expect(shouldInterruptForMicrophoneSpeech({
      captureActive: true,
      companionTalking: true,
      liveUserId: 'utterance-1',
      lastInterruptedLiveUserId: null,
    })).toBe(true);
    expect(shouldInterruptForMicrophoneSpeech({
      captureActive: true,
      companionTalking: true,
      liveUserId: 'utterance-1',
      lastInterruptedLiveUserId: 'utterance-1',
    })).toBe(false);
  });

  it('stays inert without active capture, live speech, or a companion reply', () => {
    for (const input of [
      { captureActive: false, companionTalking: true, liveUserId: 'utterance-1' },
      { captureActive: true, companionTalking: false, liveUserId: 'utterance-1' },
      { captureActive: true, companionTalking: true, liveUserId: null },
    ]) {
      expect(shouldInterruptForMicrophoneSpeech({
        ...input,
        lastInterruptedLiveUserId: null,
      })).toBe(false);
    }
  });
});
