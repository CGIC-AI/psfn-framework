import {
  DyadRelationshipAdvisoryUnavailableError,
  type DyadRelationshipAdvisory,
  type DyadRelationshipAdvisoryProvider,
} from '../../../shared/contracts/dyad-relationship-advisory.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  normalizeEmoSimDirectedRelationshipReading,
  renderDyadRelationshipAdvisory,
  type EmoSimDirectedRelationshipReading,
} from './dyad-relationship.js';
import type { EmoSimAdapterRunResult } from './emosim-adapter.js';

export interface CreateEmoSimDyadRelationshipAdvisoryProviderOptions {
  /**
   * Read-only accessor for the latest persisted sidecar observation. Kept
   * narrow so this provider never depends on the full persistence surface.
   */
  getLatestObservation: () => Promise<{ emosim?: EmoSimAdapterRunResult } | null>;
}

/**
 * Build the read-only advisory provider consumed by the companion's end-of-day
 * relationship/trust analysis. Fail-closed at the infrastructure boundary
 * (store errors are logged and thrown as unavailable); fail-soft (null) when
 * there is simply no reading to show.
 */
export function createEmoSimDyadRelationshipAdvisoryProvider(
  options: CreateEmoSimDyadRelationshipAdvisoryProviderOptions,
): DyadRelationshipAdvisoryProvider {
  const log = createComponentLogger('EmoSimDyadRelationshipAdvisory');
  return {
    async describeLatestDirectedRelationship(): Promise<DyadRelationshipAdvisory | null> {
      let observation: { emosim?: EmoSimAdapterRunResult } | null;
      try {
        observation = await options.getLatestObservation();
      } catch (error) {
        // Infrastructure boundary: surface, never swallow.
        log.warn('emo_sim dyad advisory read failed (store unavailable)', {
          error: toErrorMessage(error),
        });
        throw new DyadRelationshipAdvisoryUnavailableError(
          `emo_sim dyad advisory store read failed: ${toErrorMessage(error)}`,
          error,
        );
      }

      const emosim = observation?.emosim;
      if (!emosim || !emosim.ok) return null;
      // Persisted JSON is untrusted: read as unknown, validate defensively.
      const rawReading: unknown = emosim.output.relationship;
      if (rawReading === undefined || rawReading === null) return null;

      let reading: EmoSimDirectedRelationshipReading;
      try {
        reading = normalizeEmoSimDirectedRelationshipReading(rawReading, 'persisted emosim relationship');
      } catch (error) {
        // Persisted JSON is untrusted; a malformed row is a logged degradation,
        // not a fabricated reading and not a thrown observation failure.
        log.warn('emo_sim dyad advisory reading malformed; omitting', {
          error: toErrorMessage(error),
        });
        return null;
      }

      const observedAtMs = resolveObservedAtMs(emosim);
      return renderDyadRelationshipAdvisory(reading, observedAtMs);
    },
  };
}

function resolveObservedAtMs(emosim: EmoSimAdapterRunResult): number | null {
  if (!emosim.ok) return null;
  const observedAt = emosim.output.input.deterministic.observedAt;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? parsed : null;
}
