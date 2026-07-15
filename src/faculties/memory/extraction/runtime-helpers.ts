import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { countMessageTokens } from '../../../primitives/llm/tokens.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { isNonConversationalSessionEntry } from '../../../core/session/manager-primitives.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import type {
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionTriggerReason,
  ProfileSynthesisConfig,
} from './types.js';

const log = createComponentLogger('Extraction');

// ── Trigger evaluation ──

interface ExtractionCoverageState {
  count: number;
  coveredUpToMessageId: number | null;
}

const extractionCoverage = new Map<string, ExtractionCoverageState>();

export function resetLastExtractionCount(): void {
  extractionCoverage.clear();
}

function toTokenMessage(entry: { role: string; content: string }): { role: string; content: string } | null {
  if (entry.role !== 'assistant' && entry.role !== 'user') {
    return null;
  }
  return { role: entry.role, content: entry.content };
}

function isCountableExtractionEntry(entry: SessionEntry): boolean {
  return !isNonConversationalSessionEntry(entry)
    && (entry.role === 'assistant' || entry.role === 'user');
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

function evaluateExtractionTriggerInputs(input: {
  currentCount: number;
  lastCount: number;
  deltaMessages: number;
  runtimeConfig: SubstrateConfig | null;
  extractionInterval: number;
  thresholdEntries: () => readonly SessionEntry[];
}): ExtractionTriggerResult | null {
  const interval = input.runtimeConfig?.extractionInterval ?? input.extractionInterval;
  const intervalMet = input.deltaMessages >= interval;
  let thresholdMet = false;
  let totalTokens = 0;
  let tokenBudget = 0;
  let thresholdPct: number | null = null;
  if (input.runtimeConfig && !intervalMet) {
    const chatSlot = input.runtimeConfig.modelRoster.chat;
    const contextWindow = chatSlot?.contextWindow ?? input.runtimeConfig.defaultContextWindow;
    thresholdPct = input.runtimeConfig.extractionThresholdPct;
    tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));
    totalTokens = countMessageTokens(
      input.thresholdEntries()
        .filter(isCountableExtractionEntry)
        .map(toTokenMessage)
        .filter((message): message is { role: string; content: string } => message !== null),
    );
    thresholdMet = totalTokens > tokenBudget;
  }

  if (!intervalMet && !thresholdMet) return null;
  return {
    triggerReason: intervalMet && thresholdMet
      ? 'interval_and_threshold'
      : intervalMet
        ? 'interval'
        : 'context_threshold',
    currentCount: input.currentCount,
    lastCount: input.lastCount,
    interval,
    thresholdPct,
    totalTokens,
    tokenBudget,
  };
}

/**
 * Evaluates whether an extraction should be triggered based on message interval
 * and/or context token threshold. Returns the trigger result, or null if no
 * extraction is needed.
 *
 * Side-effect: updates extraction coverage when a trigger fires.
 */
export function evaluateExtractionTrigger(
  channelId: string,
  sessionManager: SessionManager,
  runtimeConfig: SubstrateConfig | null,
  extractionInterval: number,
): ExtractionTriggerResult | null {
  const currentCount = sessionManager.getMessageCount(channelId);
  const previous = extractionCoverage.get(channelId);
  const lastCount = previous?.count ?? 0;
  const trigger = evaluateExtractionTriggerInputs({
    currentCount,
    lastCount,
    deltaMessages: currentCount - lastCount,
    runtimeConfig,
    extractionInterval,
    thresholdEntries: () => sessionManager.getRecentMessages(channelId),
  });
  if (!trigger) return null;

  extractionCoverage.set(channelId, {
    count: currentCount,
    coveredUpToMessageId: previous?.coveredUpToMessageId ?? null,
  });

  return trigger;
}

/**
 * Evaluates a durable bounded snapshot without consulting newer live session
 * state. Unlike the foreground evaluator, coverage is committed separately
 * after the bounded extraction succeeds.
 */
export function evaluateExtractionTriggerForSnapshot(
  channelId: string,
  entries: readonly SessionEntry[],
  runtimeConfig: SubstrateConfig | null,
  extractionInterval: number,
): ExtractionTriggerResult | null {
  const previous = extractionCoverage.get(channelId);
  const lastCount = previous?.count ?? 0;
  const coveredUpToMessageId = previous?.coveredUpToMessageId;
  const uncoveredCount = entries.filter(entry => (
    isCountableExtractionEntry(entry)
    && Number.isSafeInteger(entry.id)
    && (coveredUpToMessageId === null
      || coveredUpToMessageId === undefined
      || entry.id > coveredUpToMessageId)
  )).length;
  const currentCount = lastCount + uncoveredCount;
  return evaluateExtractionTriggerInputs({
    currentCount,
    lastCount,
    deltaMessages: uncoveredCount,
    runtimeConfig,
    extractionInterval,
    thresholdEntries: () => entries,
  });
}

export interface ExtractionWatermarkAdvance {
  previousCount: number;
  nextCount: number;
  coveredUpToMessageId: number;
}

/**
 * Advances interval coverage after any successful extraction that supplied an
 * explicit bounded snapshot, so later triggers do not re-send those entries.
 *
 * Coverage is recorded only from the consumed snapshot: countable entries
 * beyond the prior bounded marker advance the count, and the maximum consumed
 * id advances the marker. This helper never consults live session state.
 * Callers must invoke it only after extraction succeeds so failures remain
 * eligible for crash recovery or a later interval trigger.
 */
export function advanceExtractionWatermarkForCoverage(
  channelId: string,
  consumedEntries: readonly SessionEntry[],
): ExtractionWatermarkAdvance | null {
  let coveredUpToMessageId: number | null = null;
  for (const entry of consumedEntries) {
    if (!Number.isFinite(entry.id)) continue;
    if (coveredUpToMessageId === null || entry.id > coveredUpToMessageId) {
      coveredUpToMessageId = entry.id;
    }
  }
  if (coveredUpToMessageId === null) return null;
  const previous = extractionCoverage.get(channelId);
  const previousCount = previous?.count ?? 0;
  const previousCoveredId = previous?.coveredUpToMessageId;
  const newlyCoveredCount = consumedEntries.filter(entry => (
    isCountableExtractionEntry(entry)
    && Number.isSafeInteger(entry.id)
    && (previousCoveredId === null
      || previousCoveredId === undefined
      || entry.id > previousCoveredId)
  )).length;
  const nextCount = previousCount + newlyCoveredCount;
  extractionCoverage.set(channelId, {
    count: nextCount,
    coveredUpToMessageId: Math.max(previousCoveredId ?? 0, coveredUpToMessageId),
  });
  if (nextCount <= previousCount) return null;

  return { previousCount, nextCount, coveredUpToMessageId };
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
  costTelemetry: CostTelemetryPort,
  telemetryEnabled: boolean,
  channelId: string,
  triggerReason: ExtractionTriggerReason,
  turnId?: TurnID,
): Promise<void> {
  if (!telemetryEnabled) {
    await costTelemetry.recordMemoryExtractionStart({
      channelId,
      ...(turnId ? { turnId } : {}),
    });
    return;
  }

  await costTelemetry.recordMemoryExtractionStart(
    { channelId, triggerReason, ...(turnId ? { turnId } : {}) },
  );
}

export async function emitExtractionEnd(
  costTelemetry: CostTelemetryPort,
  telemetryEnabled: boolean,
  telemetry: ExtractionEndTelemetry,
): Promise<void> {
  if (!telemetryEnabled) {
    await costTelemetry.recordMemoryExtractionEnd({
      channelId: telemetry.channelId,
      count: telemetry.count,
      ...(telemetry.turnId ? { turnId: telemetry.turnId } : {}),
    });
    return;
  }

  await costTelemetry.recordMemoryExtractionEnd(
    telemetry,
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
