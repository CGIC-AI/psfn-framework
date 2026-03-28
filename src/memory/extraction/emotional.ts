import type { SessionEntry } from '../../session/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { ContactStore } from '../../contacts/store.js';
import type { ExtractedFact } from '../types.js';
import { deriveEmotionalSignal } from './signals.js';

const log = createComponentLogger('Extraction');

export interface PersistEmotionalStateOptions {
  canonicalContactId: string | undefined;
  acceptedFacts: ExtractedFact[];
  recentEntries: SessionEntry[];
  contactStore: ContactStore | null;
  telemetryEnabled: boolean;
}

export function persistEmotionalStateFromExtraction(
  options: PersistEmotionalStateOptions,
): void {
  if (!options.canonicalContactId) return;
  if (!options.contactStore) return;

  const signal = deriveEmotionalSignal(options.acceptedFacts, options.recentEntries);
  if (!signal) return;

  try {
    const updated = options.contactStore.updateEmotionalBaseline(options.canonicalContactId, {
      valence: signal.valence,
      confidence: signal.confidence,
      observedAtMs: Date.now(),
    });
    if (!updated) return;

    if (options.telemetryEnabled) {
      log.debug('Updated contact emotional baseline from extraction signals', {
        canonicalContactId: options.canonicalContactId,
        signalValence: signal.valence,
        signalConfidence: signal.confidence,
        moodBaseline: updated.emotionalBaseline?.valenceBaseline ?? 0,
        moodValence: updated.emotionalBaseline?.moodValence ?? 0,
        moodDrift: updated.emotionalBaseline?.moodDrift ?? 0,
        moodSamples: updated.emotionalBaseline?.moodSamples ?? 0,
      });
    }
  } catch (error) {
    log.warn('Failed to persist emotional baseline update', {
      canonicalContactId: options.canonicalContactId,
      error: toErrorMessage(error),
    });
  }
}
