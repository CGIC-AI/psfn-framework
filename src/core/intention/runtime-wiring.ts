import type Database from 'better-sqlite3';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { IntentionPostTurnHook } from '../agent/substrate-agent.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import {
  type ActiveConcernContextProvider,
  type ConcernStorePort,
} from './concerns.js';
import {
  type PendingFollowUpContextProvider,
  type PendingFollowUpStorePort,
} from './pending-follow-ups.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from './appraisal.js';
import {
  scoreBehavioralOutcomeFromEmotion,
  type BehavioralPatternContextProvider,
  type BehavioralPatternStorePort,
} from './patterns.js';
import {
  createSQLiteIntentionRuntimeStores,
  type SQLiteIntentionRuntimeStores,
} from './sqlite-adapters.js';
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
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternStorePort;
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
  }): Promise<void>;
  onIntentionFollowUpDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: ChannelType;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }): Promise<string | undefined>;
  onIntentionFollowUpActivated(input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }): Promise<void>;
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

function toActiveConcernSnapshot(
  concern: Awaited<ReturnType<ConcernStorePort['getActiveConcerns']>>[number],
): ActiveConcernSnapshot {
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
  concern: Awaited<ReturnType<ConcernStorePort['listRecentlyResolvedConcerns']>>[number],
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
  concernStore: ConcernStorePort,
  pendingFollowUpStore?: PendingFollowUpStorePort,
): IntentionAppraisalHooks {
  return {
    getActiveConcerns: async ({ canonicalContactKey }) => (
      (await concernStore.getActiveConcerns(canonicalContactKey))
        .map(concern => toActiveConcernSnapshot(concern))
    ),
    getRecentResolvedConcerns: async ({ canonicalContactKey }) => (
      (await concernStore.listRecentlyResolvedConcerns(canonicalContactKey, {
        withinMs: RECENT_RESOLVED_CONCERN_WINDOW_MS,
        limit: RECENT_RESOLVED_CONCERN_SNAPSHOT_LIMIT,
      }))
        .map(concern => toRecentlyResolvedConcernSnapshot(concern))
    ),
    onIntentionConcernDecision: async ({
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
      const recentMatch = await concernStore.findRecentlyResolvedSimilarConcern({
        text,
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
      });
      if (recentMatch) {
        return;
      }
      await concernStore.create({
        text,
        priority: decision.concern?.priority ?? decision.priority,
        source: 'appraisal',
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
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
      const followUp = await pendingFollowUpStore.create({
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
    onIntentionFollowUpActivated: async ({
      pendingFollowUpId,
      activationReason,
    }) => {
      if (!pendingFollowUpStore) {
        throw new Error('PendingFollowUpStorePort is required for follow-up activation');
      }
      await pendingFollowUpStore.markActivated(pendingFollowUpId, {
        ...(activationReason ? { activationReason } : {}),
      });
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

  target.registerTool(createCreateConcernTool(concernStore));
  target.registerTool(createListConcernsTool(concernStore));
  target.registerTool(createResolveConcernTool(concernStore));
  return {
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
  };
}
