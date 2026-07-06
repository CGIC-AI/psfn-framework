import type Database from 'better-sqlite3';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { IntentionPostTurnHook } from '../agent/substrate-agent.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type {
  ActiveConcernContextProvider,
  ConcernStorePort,
} from './concern-store-port.js';
import type { ActiveConcernVAD } from './concerns.js';
import {
  evaluatePendingFollowUpActivationState,
  filterPendingFollowUpsForActiveChannel,
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
import {
  createSQLiteIntentionRuntimeStores,
  type SQLiteIntentionRuntimeStores,
} from './sqlite-adapters.js';

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
  }): Promise<void>;
  onIntentionFollowUpDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: ChannelType;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }): Promise<string | undefined>;
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
  }): Promise<void>;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveFollowUpDecisionContent(decision: IntentionActionDecision): string {
  if (decision.type !== 'followUp') {
    throw new Error(`Expected followUp decision, received "${decision.type}"`);
  }
  const content = normalizeOptionalText(decision.followUp?.content);
  if (!content) {
    throw new Error('Follow-up decision must include followUp.content');
  }
  return content;
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

export function createIntentionAppraisalHooks(
  concernStore: ConcernStorePort,
  pendingFollowUpStore?: PendingFollowUpStorePort,
): IntentionAppraisalHooks {
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
        sourceMessageId,
      });
    },
    onIntentionFollowUpDecision: async ({
      decision,
      channelId,
      channelType,
      canonicalContactKey,
      sourceMessageId,
    }) => {
      if (decision.type !== 'followUp') {
        return undefined;
      }
      if (!pendingFollowUpStore) {
        throw new Error('PendingFollowUpStorePort is required for follow-up decisions');
      }
      const content = resolveFollowUpDecisionContent(decision);
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
      const activated = await pendingFollowUpStore.dequeue(pendingFollowUpId, {
        ...(activationReason ? { activationReason } : {}),
      });
      return activated !== null;
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
    }) => {
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

      await patternTracker.recordResponseStrategy({
        contactId,
        sourceMessageId: sourceId,
        responseContent: normalizedResponse,
        ...(createdAt ? { createdAt } : {}),
      });
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
    target.registerIntentionPostTurnHook(async (context) => {
      await behavioralHooks.onTurnResponseRecorded({
        canonicalContactKey: context.canonicalContactKey,
        sourceMessageId: context.message.id,
        responseContent: context.response.content,
        completedAtMs: context.completedAt,
      });
    });
  }

  return {
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  };
}

export function wireIntentionRuntime(
  target: IntentionRuntimeTarget,
  db: Database.Database,
): IntentionRuntimeWiring {
  const {
    concernProvider,
    pendingFollowUpProvider,
    behavioralPatternProvider,
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  }: SQLiteIntentionRuntimeStores = createSQLiteIntentionRuntimeStores(db);
  return wireIntentionRuntimeStores(
    target,
    {
      concernStore,
      pendingFollowUpStore,
      behavioralPatternTracker,
    },
    {
      concernProvider,
      pendingFollowUpProvider,
      behavioralPatternProvider,
    },
  );
}
