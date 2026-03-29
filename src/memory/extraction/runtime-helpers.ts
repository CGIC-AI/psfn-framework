import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import { countMessageTokens } from '../../llm/tokens.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionEntry } from '../../session/types.js';
import type { SubstrateConfig, TurnID } from '../../types.js';
import type {
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionTriggerReason,
  ProfileSynthesisConfig,
} from './types.js';

const log = createComponentLogger('Extraction');

// ── Trigger evaluation ──

const lastExtractionCount = new Map<string, number>();

export function resetLastExtractionCount(): void {
  lastExtractionCount.clear();
}

function toTokenMessage(entry: { role: string; content: string }): { role: string; content: string } {
  return { role: entry.role, content: entry.content };
}

export interface ExtractionTriggerResult {
  triggerReason: ExtractionTriggerReason;
  currentCount: number;
  lastCount: number;
  interval: number;
  thresholdPct: number | null;
  totalTokens: number;
  tokenBudget: number;
}

/**
 * Evaluates whether an extraction should be triggered based on message interval
 * and/or context token threshold. Returns the trigger result, or null if no
 * extraction is needed.
 *
 * Side-effect: updates lastExtractionCount when a trigger fires.
 */
export function evaluateExtractionTrigger(
  channelId: string,
  sessionManager: SessionManager,
  runtimeConfig: SubstrateConfig | null,
  extractionInterval: number,
): ExtractionTriggerResult | null {
  const currentCount = sessionManager.getMessageCount(channelId);
  const lastCount = lastExtractionCount.get(channelId) ?? 0;

  const interval = runtimeConfig?.extractionInterval ?? extractionInterval;
  const intervalMet = currentCount - lastCount >= interval;

  let thresholdMet = false;
  let totalTokens = 0;
  let tokenBudget = 0;
  let thresholdPct: number | null = null;
  if (runtimeConfig && !intervalMet) {
    const chatSlot = runtimeConfig.modelRoster.chat;
    const contextWindow = chatSlot?.contextWindow ?? runtimeConfig.defaultContextWindow;
    thresholdPct = runtimeConfig.extractionThresholdPct;
    tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

    const recent = sessionManager.getRecentMessages(channelId);
    totalTokens = countMessageTokens(recent.map(toTokenMessage));
    thresholdMet = totalTokens > tokenBudget;
  }

  if (!intervalMet && !thresholdMet) return null;

  const triggerReason: ExtractionTriggerReason = intervalMet && thresholdMet
    ? 'interval_and_threshold'
    : intervalMet
      ? 'interval'
      : 'context_threshold';

  lastExtractionCount.set(channelId, currentCount);

  return {
    triggerReason,
    currentCount,
    lastCount,
    interval,
    thresholdPct,
    totalTokens,
    tokenBudget,
  };
}

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
  if (typeof latestEntry.id === 'number' && Number.isFinite(latestEntry.id)) {
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
  turnId?: TurnID,
): Promise<void> {
  if (!telemetryEnabled) {
    await eventBus.emit('memory.extraction.start', {
      channelId,
      ...(turnId ? { turnId } : {}),
    });
    return;
  }

  await eventBus.emit(
    'memory.extraction.start',
    { channelId, triggerReason, ...(turnId ? { turnId } : {}) } as { channelId: string },
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
      ...(telemetry.turnId ? { turnId: telemetry.turnId } : {}),
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
  void promise
    .catch((error) => {
      log.error('Profile refresh failed', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        triggerReason: options.triggerReason,
        error: String(error),
      });
    })
    .finally(() => {
      options.inFlightProfileRefreshes.delete(promise);
      if (options.inFlightProfileByContact.get(options.canonicalContactId!) === promise) {
        options.inFlightProfileByContact.delete(options.canonicalContactId!);
      }
    });
}
