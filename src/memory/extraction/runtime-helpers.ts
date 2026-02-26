import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionEntry } from '../../session/types.js';
import type {
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionTriggerReason,
  ProfileSynthesisConfig,
} from './types.js';

const log = createComponentLogger('Extraction');

export function resolveCoveredUpToMessageId(
  sessionManager: SessionManager,
  channelId: string,
  entries: SessionEntry[],
): number | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = entries[index]?.id;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  const latestEntry = sessionManager.getRecentMessages(channelId, 1)[0];
  if (typeof latestEntry?.id === 'number' && Number.isFinite(latestEntry.id)) {
    return latestEntry.id;
  }
  return null;
}

export function recordExtractionMarker(
  sessionStore: SessionStore | null,
  channelId: string,
  coveredUpToMessageId: number | null,
): void {
  if (!sessionStore) return;
  if (coveredUpToMessageId === null) return;

  try {
    sessionStore.insertExtractionMarker(channelId, coveredUpToMessageId);
  } catch (error) {
    log.warn('Failed to persist extraction marker', {
      channelId,
      coveredUpToMessageId,
      error: String(error),
    });
  }
}

export async function emitExtractionStart(
  eventBus: EventBus,
  telemetryEnabled: boolean,
  channelId: string,
  triggerReason: ExtractionTriggerReason,
): Promise<void> {
  if (!telemetryEnabled) {
    await eventBus.emit('memory.extraction.start', { channelId });
    return;
  }

  await eventBus.emit(
    'memory.extraction.start',
    { channelId, triggerReason } as { channelId: string },
  );
}

export async function emitExtractionEnd(
  eventBus: EventBus,
  telemetryEnabled: boolean,
  telemetry: ExtractionEndTelemetry,
): Promise<void> {
  if (!telemetryEnabled) {
    await eventBus.emit('memory.extraction.end', {
      channelId: telemetry.channelId,
      count: telemetry.count,
    });
    return;
  }

  await eventBus.emit(
    'memory.extraction.end',
    telemetry as { channelId: string; count: number },
  );
}

export interface ProfileRefreshQueueOptions {
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId: string | undefined;
  acceptedWrites: AcceptedFactWrite[];
  acceptingExtractions: boolean;
  profileConfig: ProfileSynthesisConfig;
  telemetryEnabled: boolean;
  inFlightProfileByContact: Map<string, Promise<void>>;
  inFlightProfileRefreshes: Set<Promise<void>>;
  startRefresh: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string,
    acceptedWrites: AcceptedFactWrite[],
    config: ProfileSynthesisConfig,
  ) => Promise<void>;
}

export function scheduleProfileRefresh(options: ProfileRefreshQueueOptions): void {
  if (!options.canonicalContactId) return;
  if (!options.acceptingExtractions) return;
  if (!options.profileConfig.enabled) return;

  const existing = options.inFlightProfileByContact.get(options.canonicalContactId);
  if (existing) {
    if (options.telemetryEnabled) {
      log.debug('Profile refresh already in flight; skipping trigger', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        triggerReason: options.triggerReason,
      });
    }
    return;
  }

  const promise = options.startRefresh(
    options.channelId,
    options.triggerReason,
    options.canonicalContactId,
    options.acceptedWrites,
    options.profileConfig,
  );
  options.inFlightProfileRefreshes.add(promise);
  options.inFlightProfileByContact.set(options.canonicalContactId, promise);
  promise.finally(() => {
    options.inFlightProfileRefreshes.delete(promise);
    if (options.inFlightProfileByContact.get(options.canonicalContactId!) === promise) {
      options.inFlightProfileByContact.delete(options.canonicalContactId!);
    }
  });
}
