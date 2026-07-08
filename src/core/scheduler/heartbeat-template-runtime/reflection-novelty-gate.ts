import type { Contact } from '../../contacts/types.js';
import { evaluateDeterministicGate } from '../../../shared/gating/deterministic-gate.js';
import { DEFAULT_REFLECTION_NOVELTY_GATE } from '../../../system/config/scheduler-config.js';
import type { ReflectionTemplate } from '../heartbeat-policy.js';
import type { HeartbeatRuntimeOptions } from '../heartbeat-runtime-contracts.js';
import { resolveReflectionContactSessionId } from './reflection-contact-session.js';
import {
  REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
  REFLECTION_NOVELTY_GATE_LANE,
  REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
  buildReflectionNoveltyGateDefinition,
  normalizeFiniteTimestamp,
} from './runtime-helpers.js';

interface ReflectionNoveltyGateLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ReflectionNoveltyGateOutcome {
  open: boolean;
  reason: string;
  inputs: Record<string, number | string>;
  scopeKey: string;
}

export function resolveReflectionNoveltyScopeKey(
  canonicalContactId: string | undefined,
  groupScope: { channelId: string } | undefined,
): string {
  if (groupScope) return `group:${groupScope.channelId}`;
  if (canonicalContactId) return `contact:${canonicalContactId}`;
  return 'substrate';
}

/**
 * jpvd.4 novelty gate for cadence-fired reflection templates: deterministic
 * "new scope entries since this template's last reflection" count against a
 * per-template/scope watermark. Opens with an explicit bypass reason when a
 * deterministic count is not available (no watermark store, no session
 * signal, or no live activity stream bound to the scope) — the gate never
 * guesses, and every consultation is visible through the typed gate event.
 */
export async function evaluateReflectionNoveltyGate(input: {
  template: ReflectionTemplate;
  reflectionChannelId: string;
  canonicalContactId: string | undefined;
  groupScope: { channelId: string } | undefined;
  runtimeOptions: HeartbeatRuntimeOptions;
}): Promise<ReflectionNoveltyGateOutcome> {
  const {
    template,
    reflectionChannelId,
    canonicalContactId,
    groupScope,
    runtimeOptions,
  } = input;
  const scopeKey = resolveReflectionNoveltyScopeKey(canonicalContactId, groupScope);
  const minNewEntries = runtimeOptions.reflectionNoveltyGate?.minNewEntries
    ?? DEFAULT_REFLECTION_NOVELTY_GATE.minNewEntries;
  const baseInputs: Record<string, number | string> = {
    templateId: template.id,
    scope: scopeKey,
    minNewEntries,
  };

  const watermarkStore = runtimeOptions.episodicWatermarkStore;
  if (!watermarkStore) {
    return { open: true, reason: 'no_watermark_store', inputs: baseInputs, scopeKey };
  }
  const sessionManager = runtimeOptions.sessionManager;
  if (!sessionManager?.getRecentMessages) {
    return { open: true, reason: 'no_activity_signal', inputs: baseInputs, scopeKey };
  }

  let activitySessionId: string | undefined;
  if (groupScope) {
    activitySessionId = groupScope.channelId;
  } else if (canonicalContactId) {
    const contact = runtimeOptions.contactStore?.getById
      ? await runtimeOptions.contactStore.getById(canonicalContactId) as Contact | undefined
      : undefined;
    activitySessionId = resolveReflectionContactSessionId(contact ?? null, reflectionChannelId);
  }
  // The internal reflection channel is the reflection's own output stream,
  // not scope activity; counting it would let reflections feed themselves.
  if (!activitySessionId || activitySessionId === reflectionChannelId) {
    return { open: true, reason: 'no_activity_signal', inputs: baseInputs, scopeKey };
  }

  const watermark = await watermarkStore.getProcessingWatermark({
    processor: REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
    sourceRef: template.id,
    channelId: scopeKey,
  });
  const watermarkMs = watermark?.lastProcessedAt
    ? Date.parse(watermark.lastProcessedAt)
    : Number.NaN;

  const newEntriesSinceLastReflection = sessionManager
    .getRecentMessages(activitySessionId, REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT)
    .filter((entry) => {
      if (entry.role !== 'user' && entry.role !== 'assistant') return false;
      const timestamp = normalizeFiniteTimestamp((entry as { timestamp?: unknown }).timestamp);
      if (timestamp === undefined) return false;
      return !Number.isFinite(watermarkMs) || timestamp > watermarkMs;
    })
    .length;

  const decision = evaluateDeterministicGate(
    buildReflectionNoveltyGateDefinition(minNewEntries),
    {
      ...baseInputs,
      newEntriesSinceLastReflection,
      ...(Number.isFinite(watermarkMs)
        ? { lastReflectionAt: new Date(watermarkMs).toISOString() }
        : {}),
    },
  );
  return {
    open: decision.open,
    reason: decision.reason,
    inputs: decision.inputs as Record<string, number | string>,
    scopeKey,
  };
}

export async function emitReflectionNoveltyGateEvent(input: {
  outcome: 'ran' | 'skipped';
  gate: Pick<ReflectionNoveltyGateOutcome, 'reason' | 'inputs'>;
  reflectionChannelId: string;
  runtimeOptions: HeartbeatRuntimeOptions;
  logger: ReflectionNoveltyGateLogger;
}): Promise<void> {
  const {
    outcome,
    gate,
    reflectionChannelId,
    runtimeOptions,
    logger,
  } = input;
  if (!runtimeOptions.eventBus) {
    return;
  }
  try {
    await runtimeOptions.eventBus.emit('reflection.template.novelty.gate', {
      lane: REFLECTION_NOVELTY_GATE_LANE,
      outcome,
      reason: gate.reason,
      inputs: gate.inputs,
      timestamp: Date.now(),
      channelId: reflectionChannelId,
    });
  } catch (error) {
    logger.warn('Failed to emit reflection novelty gate telemetry', {
      outcome,
      reason: gate.reason,
      error: String(error),
    });
  }
}

/**
 * Advance the per-template/scope novelty watermark after a completed
 * reflection run (any execution source: a manual reflection also consumed
 * the scope's novelty). Failures are loud but do not fail the delivered
 * reflection; an unadvanced watermark only makes the next cadence run more
 * likely to fire.
 */
export async function advanceReflectionNoveltyWatermark(input: {
  template: ReflectionTemplate;
  canonicalContactId: string | undefined;
  groupScope: { channelId: string } | undefined;
  runtimeOptions: HeartbeatRuntimeOptions;
  logger: ReflectionNoveltyGateLogger;
}): Promise<void> {
  const {
    template,
    canonicalContactId,
    groupScope,
    runtimeOptions,
    logger,
  } = input;
  const watermarkStore = runtimeOptions.episodicWatermarkStore;
  if (!watermarkStore) {
    return;
  }
  const scopeKey = resolveReflectionNoveltyScopeKey(canonicalContactId, groupScope);
  const watermarkScope = {
    processor: REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
    sourceRef: template.id,
    channelId: scopeKey,
  };
  try {
    const existing = await watermarkStore.getProcessingWatermark(watermarkScope);
    const nowIso = new Date().toISOString();
    await watermarkStore.upsertProcessingWatermark({
      ...watermarkScope,
      ...(existing?.id ? { id: existing.id } : {}),
      previousWatermarkJson: existing?.nextWatermarkJson ?? {},
      nextWatermarkJson: {
        lastReflection: { at: nowIso, templateId: template.id, scope: scopeKey },
      },
      status: 'active',
      reconciliationStatus: 'clean',
      lastProcessedAt: nowIso,
    });
  } catch (error) {
    logger.warn('Reflection novelty watermark advance skipped', {
      templateId: template.id,
      scope: scopeKey,
      error: String(error),
    });
  }
}
