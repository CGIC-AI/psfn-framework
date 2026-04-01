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
  CareReminderStore,
  type CareReminderContextProvider,
} from './care-reminders.js';
import {
  PendingFollowUpStore,
  evaluatePendingFollowUpWakeState,
  type PendingFollowUpContextProvider,
  type PendingFollowUp,
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
  careReminderProvider?: CareReminderContextProvider | null;
  behavioralPatternProvider?: BehavioralPatternContextProvider | null;
  setActiveConcernProvider?: (provider: ActiveConcernContextProvider | null) => void;
  setPendingFollowUpProvider?: (provider: PendingFollowUpContextProvider | null) => void;
  setCareReminderProvider?: (provider: CareReminderContextProvider | null) => void;
  setBehavioralPatternProvider?: (provider: BehavioralPatternContextProvider | null) => void;
  registerIntentionPostTurnHook?: (hook: IntentionPostTurnHook) => (() => void) | void;
  registerTool: ToolRegistrar;
}

export interface IntentionRuntimeWiring {
  concernStore: ActiveConcernStore;
  pendingFollowUpStore: PendingFollowUpStore;
  careReminderStore: CareReminderStore;
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
  getPendingFollowUpsForResurfacing(input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    isBackgroundTurn: boolean;
    now: number;
    motivationSignals?: readonly string[];
    currentMoodValence?: number | null;
  }): readonly PendingFollowUp[];
  onIntentionFollowUpActivated(input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }): boolean;
  onIntentionReminderDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: ChannelType;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }): string | undefined;
  onIntentionReminderTriggered(input: {
    reminderId: string;
  }): IntentionReminderTriggerResult | undefined;
}

export interface IntentionReminderTriggerResult {
  reminderId: string;
  content: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  nextDueAt?: string;
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

function resolveReminderDecisionTitle(decision: IntentionActionDecision): string {
  if (decision.type !== 'reminder') {
    throw new Error(`Expected reminder decision, received "${decision.type}"`);
  }
  const title = normalizeOptionalText(decision.reminder?.title);
  if (!title) {
    throw new Error('Reminder decision must include reminder.title');
  }
  return title;
}

function resolveReminderDecisionContent(decision: IntentionActionDecision): string {
  if (decision.type !== 'reminder') {
    throw new Error(`Expected reminder decision, received "${decision.type}"`);
  }
  const content = normalizeOptionalText(decision.reminder?.content);
  if (!content) {
    throw new Error('Reminder decision must include reminder.content');
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

function normalizeReminderIsoTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(Math.floor(value)).toISOString();
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

function normalizeOptionalIsoTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(Math.floor(value)).toISOString();
}

export function createIntentionAppraisalHooks(
  concernStore: ActiveConcernStore,
  pendingFollowUpStore: PendingFollowUpStore,
  careReminderStore: CareReminderStore,
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
      const pendingFollowUpId = normalizeOptionalText(decision.followUp?.pendingFollowUpId);
      const dueAt = normalizeOptionalIsoTimestamp(decision.dueAt);
      const followUpInput = {
        content,
        priority: decision.priority,
        timing: decision.timing === 'none' ? 'immediate' : decision.timing,
        channelId: normalizeOptionalText(decision.followUp?.channelId) ?? channelId,
        channelType: decision.followUp?.channelType ?? channelType,
        authorId: 'system:intention',
        authorName: 'Whisper',
        ...(dueAt ? { dueAt } : {}),
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        sourceMessageId,
        contextSummary: normalizeOptionalText(decision.followUp?.contextSummary)
          ?? normalizeOptionalText(decision.reason),
        wakeConditions: decision.followUp?.wakeConditions,
      } satisfies Parameters<PendingFollowUpStore['create']>[0];
      const followUp = pendingFollowUpId
        ? pendingFollowUpStore.update(pendingFollowUpId, followUpInput)
          ?? pendingFollowUpStore.create(followUpInput)
        : pendingFollowUpStore.create(followUpInput);
      return followUp.id;
    },
    getPendingFollowUpsForResurfacing: ({
      canonicalContactKey,
      sourceMessageId,
      isBackgroundTurn,
      now,
      motivationSignals,
      currentMoodValence,
    }) => (
      pendingFollowUpStore
        .getPendingFollowUps(canonicalContactKey)
        .filter(followUp => followUp.sourceMessageId !== sourceMessageId)
        .filter((followUp) => {
          const wakeState = evaluatePendingFollowUpWakeState(followUp, {
            now,
            isBackgroundTurn,
            motivationSignals,
            currentMoodValence,
          });
          return wakeState.matchedWakeConditions.length > 0;
        })
    ),
    onIntentionFollowUpActivated: ({
      pendingFollowUpId,
      activationReason,
    }) => {
      return pendingFollowUpStore.markActivated(pendingFollowUpId, {
        ...(activationReason ? { activationReason } : {}),
      }) !== null;
    },
    onIntentionReminderDecision: ({
      decision,
      channelId,
      channelType,
      canonicalContactKey,
      sourceMessageId,
    }) => {
      if (decision.type !== 'reminder') {
        return undefined;
      }
      const dueAt = normalizeReminderIsoTimestamp(decision.dueAt);
      if (!dueAt) {
        return undefined;
      }
      const reminder = careReminderStore.create({
        kind: decision.reminder?.kind ?? 'self_reminder',
        classification: decision.reminder?.classification ?? 'self_note',
        title: resolveReminderDecisionTitle(decision),
        content: resolveReminderDecisionContent(decision),
        schedule: decision.reminder?.schedule ?? 'one_time',
        dueAt,
        channelId: normalizeOptionalText(decision.reminder?.channelId) ?? channelId,
        channelType: decision.reminder?.channelType ?? channelType,
        authorId: 'system:intention',
        authorName: 'Whisper',
        provenanceSource: 'companion_appraisal',
        provenanceReason: normalizeOptionalText(decision.reason) ?? 'Companion-authored reminder',
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        sourceMessageId,
      });
      return reminder.id;
    },
    onIntentionReminderTriggered: ({
      reminderId,
    }) => {
      const reminder = careReminderStore.getById(reminderId);
      if (!reminder || reminder.status !== 'active') {
        return undefined;
      }
      const updated = careReminderStore.markTriggered(reminderId);
      if (!updated) {
        return undefined;
      }
      return {
        reminderId: updated.id,
        content: reminder.content,
        channelId: reminder.channelId,
        channelType: reminder.channelType,
        authorId: reminder.authorId,
        authorName: reminder.authorName,
        ...(updated.status === 'active' ? { nextDueAt: updated.dueAt } : {}),
      };
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
  const careReminderStore = new CareReminderStore(db);
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

  if (typeof target.setCareReminderProvider === 'function') {
    target.setCareReminderProvider(careReminderStore);
  } else {
    target.careReminderProvider = careReminderStore;
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
    careReminderStore,
    behavioralPatternTracker,
  };
}
