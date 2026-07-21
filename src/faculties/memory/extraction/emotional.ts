import type { SessionEntry } from '../../../core/session/types.js';
import { isTestingSessionId } from '../../../core/session/session-id.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { ExtractedFact } from '../types.js';
import { deriveEmotionalSignal } from './signals.js';

export interface PersistEmotionalStateOptions {
  sourceSessionId: string;
  canonicalContactId: string | undefined;
  acceptedFacts: ExtractedFact[];
  recentEntries: SessionEntry[];
  contactStore: ContactStorePort | null;
  telemetryEnabled: boolean;
}

export async function persistEmotionalStateFromExtraction(
  options: PersistEmotionalStateOptions,
): Promise<string | undefined> {
  if (isTestingSessionId(options.sourceSessionId)) return;
  if (!options.canonicalContactId) return;
  if (!options.contactStore) return;

  const signal = deriveEmotionalSignal(options.acceptedFacts, options.recentEntries);
  if (!signal) return;

  const updated = await options.contactStore.updateEmotionalBaseline(options.canonicalContactId, {
    valence: signal.valence,
    confidence: signal.confidence,
    observedAtMs: Date.now(),
  });
  return updated?.id;
}
