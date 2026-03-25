import type Database from 'better-sqlite3';
import type { ChannelType } from '../types.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { IntentionPostTurnHook } from '../agent/substrate-agent.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import {
  ActiveConcernStore,
  type ActiveConcernContextProvider,
} from './concerns.js';
import {
  PendingFollowUpStore,
  type PendingFollowUpContextProvider,
} from './pending-follow-ups.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from './appraisal.js';
import {
  BehavioralPatternTracker,
  scoreBehavioralOutcomeFromEmotion,
  type BehavioralPatternContextProvider,
} from './patterns.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
  createResolveConcernTool,
} from './tools.js';

const RECENT_RESOLVED_CONCERN_WINDOW_MS = 6 * 60 * 60 * 1_000;
const RECENT_RESOLVED_CONCERN_SNAPSHOT_LIMIT = 3;

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
  concernStore: ActiveConcernStore;
  pendingFollowUpStore: PendingFollowUpStore;
  behavioralPatternTracker: BehavioralPatternTracker;
}

export interface IntentionAppraisalHooks {
  getActiveConcerns(input: {
    channelId: string;
    canonicalContactKey?: string;
  }): readonly ActiveConcernSnapshot[];
  getRecentResolvedConcerns(input: {
    channelId: string;
    canonicalContactKey?: string;
  }): readonly ActiveConcernSnapshot[];
  onIntentionConcernDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }): void;
  onIntentionFollowUpDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: ChannelType;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }): string | undefined;
  onIntentionFollowUpActivated(input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }): void;
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
  }): void;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConcernDecisionText(decision: IntentionActionDecision): string {
  if (decision.type !== 'concern') {
    throw new Error(`Expected concern decision, received "${decision.type}"`);
  }
  if (!decision.concern) {
    throw new Error('Concern decision is missing concern payload');
  }

  const title = normalizeOptionalText(decision.concern.title);
  const summary = normalizeOptionalText(decision.concern.summary);
  if (!title && !summary) {
    throw new Error('Concern decision must include title or summary');
  }
  if (title && summary) {
    return `${title}: ${summary}`;
  }
  return title ?? summary ?? '';
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

function toActiveConcernSnapshot(concern: ReturnType<ActiveConcernStore['getActiveConcerns']>[number]): ActiveConcernSnapshot {
  const dueAtMs = Date.parse(concern.expiresAt);
  return {
    id: concern.id,
    title: concern.text,
    status: 'open',
    ...(Number.isFinite(dueAtMs) ? { dueAt: dueAtMs } : {}),
    priority: concern.priority,
  };
}

function toRecentlyResolvedConcernSnapshot(
  concern: ReturnType<ActiveConcernStore['listRecentlyResolvedConcerns']>[number],
): ActiveConcernSnapshot {
  const resolvedAtMs = concern.resolvedAt ? Date.parse(concern.resolvedAt) : Number.NaN;
  return {
    id: concern.id,
    title: concern.text,
    status: 'resolved',
    priority: concern.priority,
    ...(Number.isFinite(resolvedAtMs) ? { resolvedAt: resolvedAtMs } : {}),
    ...(concern.resolutionOutcome
      ? { summary: concern.resolutionOutcome }
      : { summary: 'Resolved recently.' }),
  };
}

function normalizeObservedAtIso(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(Math.floor(value)).toISOString();
}

export function createIntentionAppraisalHooks(
  concernStore: ActiveConcernStore,
  pendingFollowUpStore: PendingFollowUpStore,
): IntentionAppraisalHooks {
  return {
    getActiveConcerns: ({ canonicalContactKey }) => (
      concernStore
        .getActiveConcerns(canonicalContactKey)
        .map(concern => toActiveConcernSnapshot(concern))
    ),
    getRecentResolvedConcerns: ({ canonicalContactKey }) => (
      concernStore
        .listRecentlyResolvedConcerns(canonicalContactKey, {
          withinMs: RECENT_RESOLVED_CONCERN_WINDOW_MS,
          limit: RECENT_RESOLVED_CONCERN_SNAPSHOT_LIMIT,
        })
        .map(concern => toRecentlyResolvedConcernSnapshot(concern))
    ),
    onIntentionConcernDecision: ({
      decision,
      canonicalContactKey,
    }) => {
      if (decision.type !== 'concern') {
        return;
      }
      const text = resolveConcernDecisionText(decision);
      const expiresAt = normalizeFutureIsoTimestamp(
        decision.concern?.dueAt ?? decision.dueAt,
      );
      const recentMatch = concernStore.findRecentlyResolvedSimilarConcern({
        text,
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
      });
      if (recentMatch) {
        return;
      }
      concernStore.create({
        text,
        priority: decision.concern?.priority ?? decision.priority,
        source: 'appraisal',
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
    },
    onIntentionFollowUpDecision: ({
      decision,
      channelId,
      channelType,
      canonicalContactKey,
      sourceMessageId,
    }) => {
      if (decision.type !== 'followUp') {
        return undefined;
      }
      const content = resolveFollowUpDecisionContent(decision);
      const followUp = pendingFollowUpStore.create({
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
      });
      return followUp.id;
    },
    onIntentionFollowUpActivated: ({
      pendingFollowUpId,
      activationReason,
    }) => {
      pendingFollowUpStore.markActivated(pendingFollowUpId, {
        ...(activationReason ? { activationReason } : {}),
      });
    },
  };
}

export function createIntentionBehavioralPatternHooks(
  patternTracker: BehavioralPatternTracker,
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
    onTurnResponseRecorded: ({
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

      patternTracker.recordResponseStrategy({
        contactId,
        sourceMessageId: sourceId,
        responseContent: normalizedResponse,
        ...(createdAt ? { createdAt } : {}),
      });
    },
  };
}

export function wireIntentionRuntime(
  target: IntentionRuntimeTarget,
  db: Database.Database,
): IntentionRuntimeWiring {
  const concernStore = new ActiveConcernStore(db);
  const pendingFollowUpStore = new PendingFollowUpStore(db);
  const behavioralPatternTracker = new BehavioralPatternTracker(db);
  const behavioralHooks = createIntentionBehavioralPatternHooks(behavioralPatternTracker);

  if (typeof target.setActiveConcernProvider === 'function') {
    target.setActiveConcernProvider(concernStore);
  } else {
    target.activeConcernProvider = concernStore;
  }

  if (typeof target.setPendingFollowUpProvider === 'function') {
    target.setPendingFollowUpProvider(pendingFollowUpStore);
  } else {
    target.pendingFollowUpProvider = pendingFollowUpStore;
  }

  if (typeof target.setBehavioralPatternProvider === 'function') {
    target.setBehavioralPatternProvider(behavioralPatternTracker);
  } else {
    target.behavioralPatternProvider = behavioralPatternTracker;
  }

  if (typeof target.registerIntentionPostTurnHook === 'function') {
    target.registerIntentionPostTurnHook((context) => {
      behavioralHooks.onTurnResponseRecorded({
        canonicalContactKey: context.canonicalContactKey,
        sourceMessageId: context.message.id,
        responseContent: context.response.content,
        completedAtMs: context.completedAt,
      });
    });
  }

  target.registerTool(createCreateConcernTool(concernStore));
  target.registerTool(createListConcernsTool(concernStore));
  target.registerTool(createResolveConcernTool(concernStore));
  return {
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  };
}
