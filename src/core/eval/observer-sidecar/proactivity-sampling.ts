import type { EmoSimProactivityPort } from '../../emotion/emosim-proactivity-port.js';
import { EMOSIM_INTEGRATION_SURFACE, type EmoSimEngineSnapshot } from './emosim-adapter.js';

/** No projected turn, synthetic stimulus, eval-row replay, or language-model call. */
export function createEmoSimLiveStateSampler(options: {
  companionId: string;
  readCurrentState(): Promise<{ sessionId: string; snapshot: EmoSimEngineSnapshot }>;
  port: EmoSimProactivityPort;
  now?: () => number;
}): () => Promise<void> {
  let previous: { sessionId: string; t: number } | null = null;
  const now = options.now ?? Date.now;
  const observeUnavailable = async (inputId: string): Promise<void> => {
    await options.port.observe({
      companionId: options.companionId,
      observedAtMs: now(),
      source: {
        model: 'emo_sim', version: EMOSIM_INTEGRATION_SURFACE,
        availability: 'unavailable', confidence: 0,
      },
      lineage: {
        schemaVersion: 1, inputId, projectionVersion: 'emosim-live-state.v1',
        privacyClass: 'metadata_only', rawContentRedacted: true,
      },
      snapshot: null,
    });
  };
  return async () => {
    let reading: Awaited<ReturnType<typeof options.readCurrentState>>;
    try {
      reading = await options.readCurrentState();
    } catch (error) {
      previous = null;
      try {
        await observeUnavailable('emosim-live-state:read-unavailable');
      } catch (stateError) {
        throw new AggregateError([error, stateError], 'EmoSim live read and source invalidation failed');
      }
      throw error;
    }
    const { sessionId, snapshot } = reading;
    const advanced = previous?.sessionId === sessionId && snapshot.t > previous.t;
    previous = { sessionId, t: snapshot.t };
    const inputId = `emosim-live-state:${sessionId}:${snapshot.t}`;
    if (!advanced) {
      // A first read establishes the clock baseline. Frozen/regressed clocks
      // cannot count wall time toward sustained pressure, including restart.
      await observeUnavailable(`${inputId}:clock-unconfirmed`);
      return;
    }
    await options.port.observe({
      companionId: options.companionId,
      observedAtMs: now(),
      source: {
        model: 'emo_sim', version: EMOSIM_INTEGRATION_SURFACE,
        availability: 'available',
        // Exact projection of a contract-validated source vector. This is
        // observation confidence, not certainty about emotion or intent.
        confidence: 1,
      },
      lineage: {
        schemaVersion: 1, inputId, projectionVersion: 'emosim-live-state.v1',
        privacyClass: 'metadata_only', rawContentRedacted: true,
      },
      snapshot: {
        dominant: snapshot.dominant,
        emotions: snapshot.emotions,
        drives: { socialNeed: snapshot.drives.socialNeed },
      },
    });
  };
}
