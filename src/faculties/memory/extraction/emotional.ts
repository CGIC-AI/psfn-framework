import type { SessionEntry } from '../../../core/session/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { ExtractedFact } from '../types.js';
import { deriveEmotionalSignal } from './signals.js';

const log = createComponentLogger('Extraction');

export interface PersistEmotionalStateOptions {
  canonicalContactId: string | undefined;
  acceptedFacts: ExtractedFact[];
  recentEntries: SessionEntry[];
  contactStore: ContactStorePort | null;
  telemetryEnabled: boolean;
}

export async function persistEmotionalStateFromExtraction(
  options: PersistEmotionalStateOptions,
): Promise<void> {
  if (!options.canonicalContactId) return;
  if (!options.contactStore) return;

  const signal = deriveEmotionalSignal(options.acceptedFacts, options.recentEntries);
  if (!signal) return;

  // This function must never reject: it runs fire-and-forget after
  // extraction, and an unhandled rejection here takes the whole agent down.
  try {
    const updated = await options.contactStore.updateEmotionalBaseline(options.canonicalContactId, {
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
