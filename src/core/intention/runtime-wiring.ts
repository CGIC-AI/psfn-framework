import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type {
  IntentionPostTurnHook,
  IntentionPostTurnHookEffects,
} from '../agent/substrate-agent.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type {
  ActiveConcernContextProvider,
  ConcernStorePort,
} from './concern-store-port.js';
import type { ActiveConcernVAD } from './concerns.js';
import {
  evaluatePendingFollowUpActivationState,
  filterPendingFollowUpsForActiveChannel,
  MAX_TEXT_CHARS as PENDING_FOLLOW_UP_MAX_TEXT_CHARS,
  type PendingFollowUpContextProvider,
  type PendingFollowUp,
} from './pending-follow-ups.js';
import type { PendingFollowUpStorePort } from './pending-follow-up-store-port.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from './appraisal.js';
import {
  createConcernFromDecision,
  getActiveConcernSnapshots,
  getRecentlyResolvedConcernSnapshots,
} from './appraisal/concern-matching.js';
import {
  scoreBehavioralOutcomeFromEmotion,
  type BehavioralPatternContextProvider,
} from './patterns.js';
import type { BehavioralPatternStorePort } from './behavioral-pattern-store-port.js';

export interface IntentionRuntimeTarget {
  activeConcernProvider: ActiveConcernContextProvider | null;
  pendingFollowUpProvider?: PendingFollowUpContextProvider | null;
  behavioralPatternProvider?: BehavioralPatternContextProvider | null;
  setActiveConcernProvider?: (provider: ActiveConcernContextProvider | null) => void;
  setPendingFollowUpProvider?: (provider: PendingFollowUpContextProvider | null) => void;
  setBehavioralPatternProvider?: (provider: BehavioralPatternContextProvider | null) => void;
  registerIntentionPostTurnHook?: (hook: IntentionPostTurnHook) => (() => void) | void;
  registerTool: ToolRegistrar;
}

export interface IntentionRuntimeWiring {
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternStorePort;
}

export interface IntentionRuntimeProviders {
  concernProvider: ActiveConcernContextProvider | null;
  pendingFollowUpProvider: PendingFollowUpContextProvider | null;
  behavioralPatternProvider: BehavioralPatternContextProvider | null;
}

export interface IntentionAppraisalHooks {
  getActiveConcerns(input: {
    channelId: string;
    canonicalContactKey?: string;
  }): Promise<readonly ActiveConcernSnapshot[]>;
  getRecentResolvedConcerns(input: {
    channelId: string;
    canonicalContactKey?: string;
  }): Promise<readonly ActiveConcernSnapshot[]>;
  onIntentionConcernDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    formationVAD?: ActiveConcernVAD;
    originIcpRootInitiationId?: string;
  }): Promise<void>;
  onIntentionFollowUpDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: ChannelType;
    canonicalContactKey?: string;
    sourceMessageId: string;
    formationVAD?: ActiveConcernVAD;
    originIcpRootInitiationId?: string;
  }): Promise<IntentionFollowUpDisposition | undefined>;
  getPendingFollowUpsForResurfacing(input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    isBackgroundTurn: boolean;
    now: number;
    motivationSignals?: readonly string[];
    currentMoodValence?: number | null;
  }): Promise<readonly PendingFollowUp[]>;
  onIntentionFollowUpActivated(input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }): Promise<boolean>;
  onIntentionFollowUpDampened(input: {
    pendingFollowUpId: string;
    dampeningReason: string;
  }): Promise<boolean>;
}

export type IntentionFollowUpDisposition = string | {
  kind: 'scheduled_prompt';
  scheduledPromptId: string;
};

export interface LongHorizonFollowUpInput {
  content: string;
  reason: string;
  dueAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: 'system:intention';
  authorName: 'Whisper';
  contactId?: string;
  sourceMessageId: string;
  contextSummary?: string;
}

export interface IntentionBehavioralPatternHooks {
  onBehavioralPatternOutcome(input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    emotionSnapshot: EmotionStateSnapshot;
    observedAtMs?: number;
  }): Promise<void>;
  onTurnResponseRecorded(input: {
    canonicalContactKey?: string;
    sourceMessageId: string;
    responseContent: string;
    completedAtMs?: number;
  }, effects?: IntentionPostTurnHookEffects): Promise<void>;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Bound producer-side to the pending-follow-up content contract so an
// over-long, model-authored follow-up is truncated with a clear marker at the
// producer rather than throwing at the consumer's fail-closed enqueue guard
// (normalizeRequiredText → MAX_TEXT_CHARS). Whitespace is compacted first to
// match the consumer's own length measurement. The consumer check is left
// intact (psfn-framework-ktvo).
function boundFollowUpContentToContract(content: string): string {
  const compacted = content.replace(/\s+/g, ' ').trim();
  if (compacted.length <= PENDING_FOLLOW_UP_MAX_TEXT_CHARS) {
    return compacted;
  }
  return `${compacted.slice(0, PENDING_FOLLOW_UP_MAX_TEXT_CHARS - 3)}...`;
}

function resolveFollowUpDecisionContent(decision: IntentionActionDecision): string {
  if (decision.type !== 'followUp') {
    throw new Error(`Expected followUp decision, received "${decision.type}"`);
  }
  const content = normalizeOptionalText(decision.followUp?.content);
  if (!content) {
    throw new Error('Follow-up decision must include followUp.content');
  }
  return boundFollowUpContentToContract(content);
}

function normalizeFutureIsoTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized <= Date.now()) {
    return undefined;
  }
  return new Date(normalized).toISOString();
}

function normalizeObservedAtIso(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(Math.floor(value)).toISOString();
}

const PENDING_FOLLOW_UP_RESURFACE_LIMIT = 3;

export interface IntentionAppraisalHookOptions {
  /**
   * Resolves the live internal VAD to snapshot as a follow-up's completion VAD
   * at activation/dequeue (bead vw3w.3; parity with the concern
   * `resolutionVadProvider`). Fail-open: returns undefined when no trusted,
   * contact-matched emotion telemetry is available — the completion VAD is then
   * simply absent, never fabricated.
   */
  completionVadProvider?: (
    followUp: Pick<PendingFollowUp, 'id' | 'contactId'>,
    asOf: string,
  ) => ActiveConcernVAD | undefined;
  /** Current time source shared by horizon classification and persistence. */
  now?: () => number;
  /** Maximum future distance allowed in the scarce pending-follow-up queue. */
  nearTermFollowUpHorizonMs?: number;
  /** Durable long-range scheduler. Required whenever a decision crosses the configured horizon. */
  routeLongHorizonFollowUp?: (input: LongHorizonFollowUpInput) => Promise<string>;
}

export function createIntentionAppraisalHooks(
  concernStore: ConcernStorePort,
  pendingFollowUpStore?: PendingFollowUpStorePort,
  options: IntentionAppraisalHookOptions = {},
): IntentionAppraisalHooks {
  if (
    options.nearTermFollowUpHorizonMs !== undefined
    && (
      !Number.isSafeInteger(options.nearTermFollowUpHorizonMs)
      || options.nearTermFollowUpHorizonMs <= 0
    )
  ) {
    throw new Error('nearTermFollowUpHorizonMs must be a positive safe integer');
  }
  return {
    getActiveConcerns: async ({ canonicalContactKey }) => (
      await getActiveConcernSnapshots({
        concernStore,
        ...(canonicalContactKey !== undefined ? { contactId: canonicalContactKey } : {}),
      })
    ),
    getRecentResolvedConcerns: async ({ canonicalContactKey }) => (
      await getRecentlyResolvedConcernSnapshots({
        concernStore,
        ...(canonicalContactKey !== undefined ? { contactId: canonicalContactKey } : {}),
      })
    ),
    onIntentionConcernDecision: async ({
      decision,
      canonicalContactKey,
      sourceMessageId,
      formationVAD,
      originIcpRootInitiationId,
    }) => {
      if (decision.type !== 'concern') {
        return;
      }
      const expiresAt = normalizeFutureIsoTimestamp(
        decision.concern?.dueAt ?? decision.dueAt,
      );
      await createConcernFromDecision({
        concernStore,
        decision,
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(formationVAD ? { formationVAD } : {}),
        ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
        sourceMessageId,
      });
    },
    onIntentionFollowUpDecision: async ({
      decision,
      channelId,
      channelType,
      canonicalContactKey,
      sourceMessageId,
      formationVAD,
      originIcpRootInitiationId,
    }) => {
      if (decision.type !== 'followUp') {
        return undefined;
      }
      if (!pendingFollowUpStore) {
        throw new Error('PendingFollowUpStorePort is required for follow-up decisions');
      }
      const content = resolveFollowUpDecisionContent(decision);
      const nowMs = options.now?.() ?? Date.now();
      const dueAtMs = decision.dueAt;
      if (
        options.nearTermFollowUpHorizonMs !== undefined
        && typeof dueAtMs === 'number'
        && Number.isFinite(dueAtMs)
        && dueAtMs > nowMs + options.nearTermFollowUpHorizonMs
      ) {
        if (!options.routeLongHorizonFollowUp) {
          throw new Error('Long-horizon follow-up requires the durable scheduled-work router');
        }
        const scheduledPromptId = await options.routeLongHorizonFollowUp({
          content,
          reason: decision.reason,
          dueAt: new Date(Math.floor(dueAtMs)).toISOString(),
          channelId: normalizeOptionalText(decision.followUp?.channelId) ?? channelId,
          channelType: decision.followUp?.channelType ?? channelType,
          authorId: 'system:intention',
          authorName: 'Whisper',
          ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
          sourceMessageId,
          ...(decision.followUp?.contextSummary
            ? { contextSummary: decision.followUp.contextSummary }
            : {}),
        });
        return { kind: 'scheduled_prompt', scheduledPromptId };
      }
      const followUp = await pendingFollowUpStore.enqueue({
        content,
        priority: decision.priority,
        timing: decision.timing === 'none' ? 'immediate' : decision.timing,
        channelId: normalizeOptionalText(decision.followUp?.channelId) ?? channelId,
        channelType: decision.followUp?.channelType ?? channelType,
        authorId: 'system:intention',
        authorName: 'Whisper',
        ...(decision.dueAt ? { dueAt: normalizeFutureIsoTimestamp(decision.dueAt) } : {}),
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        sourceMessageId,
        ...(formationVAD ? { formationVAD } : {}),
        ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
        ...(decision.followUp?.contextSummary
          ? { contextSummary: decision.followUp.contextSummary }
          : {}),
        ...(decision.followUp?.wakeConditions?.length
          ? { wakeConditions: decision.followUp.wakeConditions }
          : {}),
      });
      if (!followUp) {
        return undefined;
      }
      return followUp.id;
    },
    getPendingFollowUpsForResurfacing: async ({
      channelId,
      canonicalContactKey,
      sourceMessageId,
      isBackgroundTurn,
      now,
      motivationSignals,
      currentMoodValence,
    }) => {
      if (!pendingFollowUpStore) {
        return [];
      }
      const asOf = new Date(now).toISOString();
      const pendingFollowUps = await pendingFollowUpStore.list({
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        includeActivated: false,
        includeExpired: false,
        asOf,
      });
      return filterPendingFollowUpsForActiveChannel(pendingFollowUps, channelId)
        .filter(followUp => followUp.sourceMessageId !== sourceMessageId)
        .filter(followUp => evaluatePendingFollowUpActivationState(followUp, {
          now,
          isBackgroundTurn,
          ...(motivationSignals ? { motivationSignals } : {}),
          ...(currentMoodValence !== undefined ? { currentMoodValence } : {}),
        }).eligibleNow)
        .slice(0, PENDING_FOLLOW_UP_RESURFACE_LIMIT);
    },
    onIntentionFollowUpActivated: async ({
      pendingFollowUpId,
      activationReason,
    }) => {
      if (!pendingFollowUpStore) {
        throw new Error('PendingFollowUpStorePort is required for follow-up activation');
      }
      // Snapshot completion VAD BEFORE the activating dequeue so the retained
      // formation→completion arc reflects the affect at the moment of
      // completion (bead vw3w.3). Peek supplies the contactId the provider
      // needs; a missing follow-up or absent telemetry leaves completion VAD
      // unset (fail-open, never fabricated).
      let completionVAD: ActiveConcernVAD | undefined;
      if (options.completionVadProvider) {
        const existing = await pendingFollowUpStore.peek(pendingFollowUpId);
        if (existing) {
          completionVAD = options.completionVadProvider(
            { id: existing.id, ...(existing.contactId ? { contactId: existing.contactId } : {}) },
            new Date().toISOString(),
          );
        }
      }
      const activated = await pendingFollowUpStore.dequeue(pendingFollowUpId, {
        ...(activationReason ? { activationReason } : {}),
        ...(completionVAD ? { completionVAD } : {}),
      });
      return activated !== null;
    },
    onIntentionFollowUpDampened: async ({
      pendingFollowUpId,
      dampeningReason,
    }) => {
      if (!pendingFollowUpStore?.dampen) {
        throw new Error('PendingFollowUpStorePort dampening is required for follow-up disposition');
      }
      const dampened = await pendingFollowUpStore.dampen(pendingFollowUpId, {
        dampeningReason,
      });
      return dampened !== null;
    },
  };
}

export function createIntentionBehavioralPatternHooks(
  patternTracker: BehavioralPatternStorePort,
): IntentionBehavioralPatternHooks {
  return {
    onBehavioralPatternOutcome: async ({
      canonicalContactKey,
      sourceMessageId,
      emotionSnapshot,
      observedAtMs,
    }) => {
      const contactId = normalizeOptionalText(canonicalContactKey);
      if (!contactId) {
        return;
      }
      const sourceId = normalizeOptionalText(sourceMessageId);
      if (!sourceId) {
        throw new Error('Behavioral pattern outcome requires sourceMessageId');
      }
      const outcomeScore = scoreBehavioralOutcomeFromEmotion(emotionSnapshot);
      const observedAt = normalizeObservedAtIso(observedAtMs);
      await patternTracker.tryRecordOutcomeForLatestPending({
        contactId,
        outcomeScore,
        ...(observedAt ? { observedAt } : {}),
        outcomeSourceMessageId: sourceId,
      });
    },
    onTurnResponseRecorded: async ({
      canonicalContactKey,
      sourceMessageId,
      responseContent,
      completedAtMs,
    }, effects) => {
      const contactId = normalizeOptionalText(canonicalContactKey);
      if (!contactId) {
        return;
      }
      const sourceId = normalizeOptionalText(sourceMessageId);
      if (!sourceId) {
        throw new Error('Behavioral pattern turn recording requires sourceMessageId');
      }
      const normalizedResponse = normalizeOptionalText(responseContent);
      if (!normalizedResponse) {
        return;
      }
      const createdAt = normalizeObservedAtIso(completedAtMs);

      const recordInput = {
        contactId,
        sourceMessageId: sourceId,
        responseContent: normalizedResponse,
        ...(createdAt ? { createdAt } : {}),
      };
      if (effects) {
        await patternTracker.recordResponseStrategy(recordInput, {
          crossEffectBoundary: effects.crossBoundary,
        });
      } else {
        await patternTracker.recordResponseStrategy(recordInput);
      }
    },
  };
}

export function wireIntentionRuntimeStores(
  target: IntentionRuntimeTarget,
  runtime: IntentionRuntimeWiring,
  providers: IntentionRuntimeProviders,
): IntentionRuntimeWiring {
  const {
    concernProvider,
    pendingFollowUpProvider,
    behavioralPatternProvider,
  } = providers;
  const {
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  } = runtime;
  const behavioralHooks = createIntentionBehavioralPatternHooks(behavioralPatternTracker);

  if (typeof target.setActiveConcernProvider === 'function') {
    target.setActiveConcernProvider(concernProvider);
  } else {
    target.activeConcernProvider = concernProvider;
  }

  if (typeof target.setPendingFollowUpProvider === 'function') {
    target.setPendingFollowUpProvider(pendingFollowUpProvider);
  } else {
    target.pendingFollowUpProvider = pendingFollowUpProvider;
  }

  if (typeof target.setBehavioralPatternProvider === 'function') {
    target.setBehavioralPatternProvider(behavioralPatternProvider);
  } else {
    target.behavioralPatternProvider = behavioralPatternProvider;
  }

  if (typeof target.registerIntentionPostTurnHook === 'function') {
    target.registerIntentionPostTurnHook(async (context, effects) => {
      await behavioralHooks.onTurnResponseRecorded({
        canonicalContactKey: context.canonicalContactKey,
        sourceMessageId: context.message.id,
        responseContent: context.response.content,
        completedAtMs: context.completedAt,
      }, effects);
    });
  }

  return {
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  };
}
