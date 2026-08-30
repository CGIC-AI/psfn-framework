import { useEffect, useRef, useState } from 'react';
import {
  createWebAudioClipSource,
  VoicePlaybackController,
  type AudioContextLike,
} from '../lib/audio/voice-playback-controller.js';
import type { HubStreamStore, VoicePlaybackState } from '../lib/stream/hub-stream.js';

/** Browser AudioContext surface this hook drives, beyond the clip-source needs. */
type ManagedAudioContext = AudioContextLike & {
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
};

type AudioContextCtor = new () => ManagedAudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return (scope.AudioContext ?? scope.webkitAudioContext) ?? null;
}

/**
 * Drive spoken-reply playback + v1 mouth lipsync from the reassembled audio
 * queue. Fail-closed and dormant by default: it does nothing until the session
 * advertises the `streamed_audio` ceiling and a reply is buffered, and it does
 * nothing when Web Audio is unavailable (text stays the source of truth).
 * Returns the current mouth-open signal for the sprite.
 */
export function useVoicePlayback(
  voicePlayback: VoicePlaybackState,
  store: HubStreamStore | null,
): boolean {
  const [mouthOpen, setMouthOpen] = useState(false);
  const controllerRef = useRef<VoicePlaybackController | null>(null);
  const contextRef = useRef<ManagedAudioContext | null>(null);
  const resetGenerationRef = useRef(voicePlayback.resetGeneration);

  function teardown(): void {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    void contextRef.current?.close?.();
    contextRef.current = null;
    setMouthOpen(false);
  }

  useEffect(() => () => teardown(), []);

  useEffect(() => {
    if (resetGenerationRef.current !== voicePlayback.resetGeneration) {
      resetGenerationRef.current = voicePlayback.resetGeneration;
      controllerRef.current?.stop();
      setMouthOpen(false);
    }
    if (!voicePlayback.supported) {
      if (controllerRef.current) teardown();
      return;
    }
    if (voicePlayback.queue.length === 0 || !store) return;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return;
    if (!controllerRef.current) {
      let context: ManagedAudioContext;
      try {
        context = new Ctor();
      } catch {
        return;
      }
      contextRef.current = context;
      controllerRef.current = new VoicePlaybackController({
        source: createWebAudioClipSource(context),
        onMouthOpen: (open) => setMouthOpen(open),
      });
    }
    void contextRef.current?.resume?.();
    for (const utterance of voicePlayback.queue) {
      controllerRef.current.enqueue(utterance);
      store.consumeVoiceUtterance(utterance.id);
    }
  }, [store, voicePlayback]);

  return mouthOpen;
}
