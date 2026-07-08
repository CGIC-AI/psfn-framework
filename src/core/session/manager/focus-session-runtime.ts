import { randomUUID } from 'node:crypto';
import type { MemoryScopeQuery } from '../../../faculties/memory/types.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  buildFocusMemoryScopeQuery,
  normalizeFocusEvidence,
  type FocusCompactionRange,
  type FocusEvidenceRecord,
  type FocusKnowledgeBlock,
  type FocusKnowledgeStore,
  type FocusProjectContextSummary,
} from '../focus-knowledge.js';
import type { SessionEntry } from '../types.js';

interface ActiveFocusSession {
  focusId: string;
  channelId: string;
  scope: string;
  startedAt: number;
  startEntryId: number;
  evidence: FocusEvidenceRecord[];
}

export interface FocusSessionSnapshot {
  focusId: string;
  channelId: string;
  scope: string;
  startedAt: number;
  startEntryId: number;
  evidenceCount: number;
  existingProjectContext: FocusProjectContextSummary | null;
}

export interface FocusSessionContextSnapshot {
  session: FocusSessionSnapshot;
  rangeStartId: number;
  rangeEndId: number;
  entries: SessionEntry[];
  evidence: FocusEvidenceRecord[];
}

export interface FocusSessionCompletionResult {
  focusId: string;
  channelId: string;
  scope: string;
  rangeStartId: number | null;
  rangeEndId: number | null;
  knowledgeBlock: FocusKnowledgeBlock;
  projectContext: FocusProjectContextSummary;
}

export interface FocusSessionRuntimeOptions {
  store: SessionStore;
  focusKnowledgeStore: FocusKnowledgeStore;
  resolveSessionChannelId: (channelId: string) => string;
}

const MAX_ACTIVE_FOCUS_EVIDENCE_ITEMS = 64;

export class FocusSessionRuntime {
  private readonly store: SessionStore;
  private readonly focusKnowledgeStore: FocusKnowledgeStore;
  private readonly resolveSessionChannelId: (channelId: string) => string;
  private readonly activeFocusSessions: Map<string, ActiveFocusSession> = new Map();

  constructor(options: FocusSessionRuntimeOptions) {
    this.store = options.store;
    this.focusKnowledgeStore = options.focusKnowledgeStore;
    this.resolveSessionChannelId = options.resolveSessionChannelId;
  }

  deleteActiveSessionsForResolvedChannels(channelIds: readonly string[]): void {
    for (const channelId of channelIds) {
      this.activeFocusSessions.delete(channelId);
    }
  }

  private toFocusSessionSnapshot(session: ActiveFocusSession): FocusSessionSnapshot {
    return {
      focusId: session.focusId,
      channelId: session.channelId,
      scope: session.scope,
      startedAt: session.startedAt,
      startEntryId: session.startEntryId,
      evidenceCount: session.evidence.length,
      existingProjectContext: this.focusKnowledgeStore.getProjectContextSummary(
        session.channelId,
        session.scope,
      ),
    };
  }

  resolveFocusChannelId(channelId: string): string {
    const normalized = channelId.trim();
    if (!normalized) {
      throw new Error('focus session requires a non-empty channelId');
    }
    return this.resolveSessionChannelId(normalized);
  }

  normalizeFocusScope(scope: string): string {
    const normalized = scope.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      throw new Error('focus scope must be non-empty');
    }
    return normalized;
  }

  getFocusKnowledgeTexts(channelId: string): string[] {
    return this.focusKnowledgeStore
      .listProjectContextsByChannel(channelId)
      .map((summary) => {
        const projectContextSuffix = summary.knowledgeBlockCount > 1
          ? ` (project context with ${summary.knowledgeBlockCount} distilled blocks, ${summary.totalEvidenceCount} evidence items)`
          : '';
        return `[${summary.scope}] ${summary.latestKnowledge}${projectContextSuffix}`;
      });
  }

  getProjectContextSummary(channelId: string, scope: string): FocusProjectContextSummary | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    return this.focusKnowledgeStore.getProjectContextSummary(resolvedChannelId, scope);
  }

  getActiveFocusMemoryScopeQuery(channelId: string): MemoryScopeQuery | null {
    const active = this.getActiveFocusSession(channelId);
    if (!active) return null;
    return buildFocusMemoryScopeQuery(active.scope);
  }

  getFocusCompactionRanges(channelId: string): FocusCompactionRange[] {
    return this.focusKnowledgeStore.getCompactionRanges(channelId);
  }

  startFocusSession(channelId: string, scope: string): FocusSessionSnapshot {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    if (this.activeFocusSessions.has(resolvedChannelId)) {
      throw new Error(`focus session already active for channel "${resolvedChannelId}"`);
    }

    const normalizedScope = this.normalizeFocusScope(scope);
    const now = Date.now();
    const startEntryId = this.store.getLastEntry(resolvedChannelId)?.id ?? 0;
    const session: ActiveFocusSession = {
      focusId: `focus-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      channelId: resolvedChannelId,
      scope: normalizedScope,
      startedAt: now,
      startEntryId,
      evidence: [],
    };
    this.activeFocusSessions.set(resolvedChannelId, session);
    return this.toFocusSessionSnapshot(session);
  }

  getActiveFocusSession(channelId: string): FocusSessionSnapshot | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    return active ? this.toFocusSessionSnapshot(active) : null;
  }

  recordFocusEvidence(channelId: string, evidence: ReadonlyArray<unknown>): number {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active || evidence.length === 0) {
      return 0;
    }

    const remainingSlots = Math.max(0, MAX_ACTIVE_FOCUS_EVIDENCE_ITEMS - active.evidence.length);
    if (remainingSlots === 0) {
      return 0;
    }

    const normalized = evidence
      .map((item) => normalizeFocusEvidence(item))
      .filter((item): item is FocusEvidenceRecord => item !== null)
      .slice(0, remainingSlots);
    if (normalized.length === 0) {
      return 0;
    }

    active.evidence.push(...normalized);
    return normalized.length;
  }

  getFocusSessionContext(channelId: string): FocusSessionContextSnapshot | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active) return null;

    const rangeStartId = active.startEntryId + 1;
    const rangeEndId = this.store.getLastEntry(resolvedChannelId)?.id ?? active.startEntryId;
    const entries = rangeEndId >= rangeStartId
      ? this.store.getEntriesInRange(resolvedChannelId, rangeStartId, rangeEndId)
      : [];

    return {
      session: this.toFocusSessionSnapshot(active),
      rangeStartId,
      rangeEndId,
      entries,
      evidence: [...active.evidence],
    };
  }

  completeFocusSession(channelId: string, knowledge: string): FocusSessionCompletionResult {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active) {
      throw new Error(`no active focus session for channel "${resolvedChannelId}"`);
    }

    const normalizedKnowledge = knowledge.replace(/\s+/g, ' ').trim();
    if (!normalizedKnowledge) {
      throw new Error('focus knowledge summary must be non-empty');
    }

    const context = this.getFocusSessionContext(resolvedChannelId);
    if (!context) {
      throw new Error(`no active focus session for channel "${resolvedChannelId}"`);
    }

    const rangeIsValid = context.rangeEndId >= context.rangeStartId;
    const knowledgeBlock = this.focusKnowledgeStore.append({
      channelId: resolvedChannelId,
      focusId: active.focusId,
      scope: active.scope,
      knowledge: normalizedKnowledge,
      startedAt: active.startedAt,
      completedAt: Date.now(),
      ...(rangeIsValid
        ? {
          rangeStartId: context.rangeStartId,
          rangeEndId: context.rangeEndId,
        }
        : {}),
      evidenceCount: active.evidence.length,
      evidence: active.evidence,
    });

    const projectContext = this.focusKnowledgeStore.getProjectContextSummary(
      resolvedChannelId,
      active.scope,
    );
    if (!projectContext) {
      throw new Error(`project context summary missing for focus scope "${active.scope}"`);
    }

    this.activeFocusSessions.delete(resolvedChannelId);
    return {
      focusId: active.focusId,
      channelId: resolvedChannelId,
      scope: active.scope,
      rangeStartId: rangeIsValid ? context.rangeStartId : null,
      rangeEndId: rangeIsValid ? context.rangeEndId : null,
      knowledgeBlock,
      projectContext,
    };
  }
}
