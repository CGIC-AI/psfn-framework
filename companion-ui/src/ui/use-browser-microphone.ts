import { useCallback, useEffect, useRef, useState } from 'react';
import type { PcmAudioStreamPort } from '../lib/api/pcm-audio.js';
import {
  BrowserMicrophoneCapture,
  browserMicrophoneSupported,
  describeMicrophoneFailure,
  ScreenWakeLockController,
} from '../lib/audio/browser-microphone.js';

export type BrowserMicrophoneState = Readonly<{
  phase: 'unsupported' | 'idle' | 'requesting' | 'active' | 'error';
  detail: string;
  handsFree: boolean;
  wakeLockHeld: boolean;
}>;

export function shouldInterruptForMicrophoneSpeech(input: {
  readonly captureActive: boolean;
  readonly companionTalking: boolean;
  readonly liveUserId: string | null;
  readonly lastInterruptedLiveUserId: string | null;
}): boolean {
  return input.captureActive
    && input.companionTalking
    && input.liveUserId !== null
    && input.liveUserId !== input.lastInterruptedLiveUserId;
}

interface CaptureLike {
  startFromUserGesture(): Promise<void>;
  stop(): Promise<void>;
}

interface WakeLockLike {
  supported(): boolean;
  acquire(): Promise<void>;
  release(): Promise<void>;
}

const IDLE_MICROPHONE_STATE: BrowserMicrophoneState = {
  phase: 'idle',
  detail: 'Microphone is off.',
  handsFree: false,
  wakeLockHeld: false,
};

export function useBrowserMicrophone(
  relay: PcmAudioStreamPort,
  options: {
    readonly supported?: boolean;
    readonly createCapture?: (onFailure: (error: Error) => void) => CaptureLike;
    readonly createWakeLock?: () => WakeLockLike;
  } = {},
) {
  const supported = options.supported ?? browserMicrophoneSupported();
  const [state, setState] = useState<BrowserMicrophoneState>(() => supported
    ? IDLE_MICROPHONE_STATE
    : {
        phase: 'unsupported',
        detail: 'This browser cannot capture 16 kHz microphone audio. Continue in the text composer.',
        handsFree: false,
        wakeLockHeld: false,
      });
  const captureRef = useRef<CaptureLike | null>(null);
  const wakeLockRef = useRef<WakeLockLike | null>(null);
  const attemptRef = useRef(0);
  const relayRef = useRef(relay);
  relayRef.current = relay;
  const createCaptureRef = useRef(options.createCapture);
  createCaptureRef.current = options.createCapture;
  const createWakeLockRef = useRef(options.createWakeLock);
  createWakeLockRef.current = options.createWakeLock;

  const stop = useCallback(async () => {
    attemptRef.current += 1;
    const capture = captureRef.current;
    const wakeLock = wakeLockRef.current;
    captureRef.current = null;
    wakeLockRef.current = null;
    await Promise.allSettled([capture?.stop(), wakeLock?.release()]);
    setState(supported ? IDLE_MICROPHONE_STATE : {
      phase: 'unsupported',
      detail: 'This browser cannot capture 16 kHz microphone audio. Continue in the text composer.',
      handsFree: false,
      wakeLockHeld: false,
    });
  }, [supported]);

  const startFromUserGesture = useCallback(async ({ handsFree = false } = {}) => {
    if (!supported || captureRef.current) return;
    const attempt = ++attemptRef.current;
    setState({
      phase: 'requesting',
      detail: 'Requesting microphone permission…',
      handsFree,
      wakeLockHeld: false,
    });
    let capture: CaptureLike | null = null;
    const onFailure = (error: Error) => {
      if (!capture || attemptRef.current !== attempt || captureRef.current !== capture) return;
      captureRef.current = null;
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      void wakeLock?.release();
      setState({
        phase: 'error',
        detail: describeMicrophoneFailure(error),
        handsFree: false,
        wakeLockHeld: false,
      });
    };
    capture = createCaptureRef.current?.(onFailure)
      ?? new BrowserMicrophoneCapture(relayRef.current, { onFailure });
    captureRef.current = capture;
    try {
      await capture.startFromUserGesture();
      if (attemptRef.current !== attempt || captureRef.current !== capture) {
        await capture.stop();
        return;
      }
      let wakeLockHeld = false;
      let wakeLockWarning = '';
      if (handsFree) {
        const wakeLock = createWakeLockRef.current?.() ?? new ScreenWakeLockController();
        wakeLockRef.current = wakeLock;
        if (wakeLock.supported()) {
          try {
            await wakeLock.acquire();
            wakeLockHeld = true;
          } catch {
            wakeLockWarning = ' Screen wake lock failed; keep this screen awake manually.';
          }
        } else {
          wakeLockWarning = ' Screen wake lock is unavailable; keep this screen awake manually.';
        }
      }
      if (attemptRef.current !== attempt || captureRef.current !== capture) {
        await Promise.allSettled([capture.stop(), wakeLockRef.current?.release()]);
        return;
      }
      setState({
        phase: 'active',
        detail: handsFree
          ? `Hands-free microphone is listening.${wakeLockWarning}`
          : 'Microphone capture is active.',
        handsFree,
        wakeLockHeld,
      });
    } catch (error) {
      if (attemptRef.current !== attempt) return;
      captureRef.current = null;
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      await wakeLock?.release().catch(() => undefined);
      setState({
        phase: 'error',
        detail: describeMicrophoneFailure(error),
        handsFree: false,
        wakeLockHeld: false,
      });
    }
  }, [supported]);

  useEffect(() => () => {
    attemptRef.current += 1;
    void captureRef.current?.stop();
    void wakeLockRef.current?.release();
    captureRef.current = null;
    wakeLockRef.current = null;
  }, []);

  return { state, startFromUserGesture, stop, supported } as const;
}
