import { useEffect, useRef, useState } from 'react';
import { TouchInteractionCoalescer, type TouchInteractionInput } from '../lib/touch-interactions.js';
import type { HubStreamStore } from '../lib/stream/hub-stream.js';

export function useCompanionTouch(store: HubStreamStore | null, enabled: boolean) {
  const coalescerRef = useRef<TouchInteractionCoalescer | null>(null);
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [petted, setPetted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPetted(false);
    setError(null);
    if (!store || !enabled) return;
    // Capture the exact store. A delayed gesture must never follow a mutable
    // current-store ref into another companion's conversation.
    const coalescer = new TouchInteractionCoalescer({
      emit: interaction => {
        try {
          store.sendTouchInteraction(interaction);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Touch delivery failed');
        }
      },
    });
    coalescerRef.current = coalescer;
    return () => {
      coalescer.destroy();
      coalescerRef.current = null;
      if (reactionTimerRef.current !== null) clearTimeout(reactionTimerRef.current);
    };
  }, [enabled, store]);

  function reset() {
    coalescerRef.current?.destroy();
    if (reactionTimerRef.current !== null) clearTimeout(reactionTimerRef.current);
    setPetted(false);
    setError(null);
  }

  function interact(interaction: TouchInteractionInput) {
    if (enabled) coalescerRef.current?.record(interaction);
  }

  function headpat() {
    if (!enabled) return;
    setPetted(true);
    if (reactionTimerRef.current !== null) clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = setTimeout(() => setPetted(false), 900);
    interact({ kind: 'headpat', region: 'head', durationMs: 0 });
  }

  return { petted, error, interact, headpat, reset };
}
