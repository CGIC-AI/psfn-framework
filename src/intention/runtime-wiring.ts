import type Database from 'better-sqlite3';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import {
  ActiveConcernStore,
  type ActiveConcernContextProvider,
} from './concerns.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from './appraisal.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
  createResolveConcernTool,
} from './tools.js';

export interface IntentionRuntimeTarget {
  activeConcernProvider: ActiveConcernContextProvider | null;
  setActiveConcernProvider?: (provider: ActiveConcernContextProvider | null) => void;
  registerTool: ToolRegistrar;
}

export interface IntentionAppraisalHooks {
  getActiveConcerns(input: {
    channelId: string;
    canonicalContactKey?: string;
  }): readonly ActiveConcernSnapshot[];
  onIntentionConcernDecision(input: {
    decision: IntentionActionDecision;
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
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

export function createIntentionAppraisalHooks(
  concernStore: ActiveConcernStore,
): IntentionAppraisalHooks {
  return {
    getActiveConcerns: ({ canonicalContactKey }) => (
      concernStore
        .getActiveConcerns(canonicalContactKey)
        .map(concern => toActiveConcernSnapshot(concern))
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
      concernStore.create({
        text,
        priority: decision.concern?.priority ?? decision.priority,
        source: 'appraisal',
        ...(canonicalContactKey ? { contactId: canonicalContactKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
    },
  };
}

export function wireIntentionRuntime(
  target: IntentionRuntimeTarget,
  db: Database.Database,
): ActiveConcernStore {
  const concernStore = new ActiveConcernStore(db);
  if (typeof target.setActiveConcernProvider === 'function') {
    target.setActiveConcernProvider(concernStore);
  } else {
    target.activeConcernProvider = concernStore;
  }
  target.registerTool(createCreateConcernTool(concernStore));
  target.registerTool(createListConcernsTool(concernStore));
  target.registerTool(createResolveConcernTool(concernStore));
  return concernStore;
}
