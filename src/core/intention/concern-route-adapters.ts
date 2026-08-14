import type { NorthStarStore } from '../../faculties/north-star/store.js';
import type { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { Awaitable } from '../../shared/utils/types.js';
import type { PendingFollowUpStorePort } from './pending-follow-up-store-port.js';
import { MAX_SUMMARY_CHARS } from './pending-follow-ups.js';
import {
  CONCERN_ROUTE_SYSTEM_CHANNEL_ID,
  concernRouteProvenanceRefs,
  type ConcernRouteHandler,
  type ConcernRouteHandlerResult,
  type ConcernRouteRequest,
} from './concern-route-handoff.js';

const MAX_ROUTE_TEXT_CHARS = 500;

export interface PendingFollowUpConcernRouteHandlerOptions {
  pendingFollowUpStore: Pick<PendingFollowUpStorePort, 'enqueue'>;
  resolveChannelType: (channelId: string) => Awaitable<ChannelType | null>;
  now?: () => Date;
}

/**
 * North-star adapter. Routes a durable-priority concern into the north-star
 * store as a *disabled draft* so it surfaces for operator review without
 * silently mutating the live prompt layer. The store's item cap and validation
 * errors surface as an explicit blocked outcome (fail closed).
 */
export function createNorthStarRouteHandler(
  store: NorthStarStore,
  options: { updatedBy?: string } = {},
): ConcernRouteHandler {
  const updatedBy = options.updatedBy ?? 'concern-routing';
  return {
    substrate: 'north_star',
    route(request: ConcernRouteRequest): ConcernRouteHandlerResult {
      try {
        const item = store.create({
          title: buildNorthStarTitle(request),
          content: buildNorthStarContent(request),
          scope: 'companion',
          enabled: false,
          updatedBy,
        });
        return {
          disposition: 'routed',
          substrate: 'north_star',
          targetRef: item.id,
          reason: `Promoted to north-star draft ${item.id} for operator review`,
        };
      } catch (error) {
        return {
          disposition: 'blocked',
          substrate: 'north_star',
          reason: `blocked route: north-star handoff failed (${toErrorMessage(error)})`,
        };
      }
    },
  };
}

/**
 * Introspection adapter. Records the routed item in the reflection journal with
 * candidate/concern provenance preserved. Append-only, no cap, no prompt or
 * outbound impact, so it is the safe default sink for grooming overflow.
 */
export function createIntrospectionRouteHandler(
  store: ReflectionJournalStore,
): ConcernRouteHandler {
  return {
    substrate: 'reflection_journal',
    route(request: ConcernRouteRequest): ConcernRouteHandlerResult {
      try {
        const provenanceRefs = concernRouteProvenanceRefs(request);
        const entry = store.append({
          templateId: 'concern_route',
          templateName: 'Concern Route',
          prompt: `Durable follow-up routed from ${request.source} (${request.target})`,
          reflection: buildReflectionText(request),
          channelId: normalizeChannelId(request.channelId),
          mode: 'deliberation',
          substrateBoundary: 'intention.concern_route',
          ...(provenanceRefs.length > 0 ? { substrateProvenanceRefs: provenanceRefs } : {}),
        });
        return {
          disposition: 'routed',
          substrate: 'reflection_journal',
          targetRef: entry.id,
          reason: `Recorded in reflection journal as ${entry.id}`,
        };
      } catch (error) {
        return {
          disposition: 'blocked',
          substrate: 'reflection_journal',
          reason: `blocked route: reflection-journal handoff failed (${toErrorMessage(error)})`,
        };
      }
    },
  };
}

/**
 * Routes a time-bound concern into the canonical durable pending-follow-up
 * substrate. The stored text is an internal review nudge: it preserves the
 * concern and its provenance without deciding or writing an outbound message
 * on the companion's behalf.
 */
export function createPendingFollowUpConcernRouteHandler(
  options: PendingFollowUpConcernRouteHandlerOptions,
): ConcernRouteHandler {
  const now = options.now ?? (() => new Date());
  return {
    substrate: 'pending_follow_up',
    async route(request: ConcernRouteRequest): Promise<ConcernRouteHandlerResult> {
      const dueAtMs = request.dueAt ? Date.parse(request.dueAt) : Number.NaN;
      if (!Number.isFinite(dueAtMs) || dueAtMs <= now().getTime()) {
        return blockedPendingFollowUpRoute('requires a future dueAt');
      }
      const channelId = request.channelId?.trim();
      if (!channelId) {
        return blockedPendingFollowUpRoute('source channel id is unavailable');
      }

      try {
        const channelType = await options.resolveChannelType(channelId);
        if (!channelType) {
          return blockedPendingFollowUpRoute('source channel type is unavailable');
        }
        const sourceMessageId = request.evidenceRefs
          .find(ref => ref.kind === 'message' && ref.ref.trim().length > 0)
          ?.ref.trim();
        const followUp = await options.pendingFollowUpStore.enqueue({
          content: buildPendingFollowUpReviewText(request),
          priority: request.priority,
          timing: 'scheduled',
          channelId,
          channelType,
          authorId: 'system:intention',
          authorName: 'Whisper',
          dueAt: new Date(dueAtMs).toISOString(),
          ...(request.contactId ? { contactId: request.contactId } : {}),
          ...(sourceMessageId ? { sourceMessageId } : {}),
          contextSummary: buildPendingFollowUpContextSummary(request),
        });
        if (!followUp) {
          return blockedPendingFollowUpRoute('pending follow-up backlog is full');
        }
        return {
          disposition: 'routed',
          substrate: 'pending_follow_up',
          targetRef: followUp.id,
          reason: `Created pending follow-up ${followUp.id} for companion review`,
        };
      } catch (error) {
        return blockedPendingFollowUpRoute(`handoff failed (${toErrorMessage(error)})`);
      }
    },
  };
}

function buildNorthStarTitle(request: ConcernRouteRequest): string {
  const title = compact(request.title, 90);
  return title.length > 0 ? title : compact(request.summary, 90) || 'Routed concern';
}

function buildNorthStarContent(request: ConcernRouteRequest): string {
  const parts = [
    request.summary,
    `Routed from ${request.source} as a durable priority (${request.reason}).`,
  ].filter(part => part.trim().length > 0);
  return compact(parts.join(' '), MAX_ROUTE_TEXT_CHARS) || 'Routed concern';
}

function buildReflectionText(request: ConcernRouteRequest): string {
  const parts = [
    `${request.title || request.summary}`,
    request.summary && request.summary !== request.title ? request.summary : '',
    `Retained for durable follow-up (source: ${request.source}, priority: ${request.priority}).`,
    request.reason ? `Rationale: ${request.reason}` : '',
  ].filter(part => part.trim().length > 0);
  return compact(parts.join(' '), MAX_ROUTE_TEXT_CHARS) || 'Routed concern retained for durable follow-up.';
}

function buildPendingFollowUpReviewText(request: ConcernRouteRequest): string {
  const subject = request.title.trim() || request.summary.trim() || 'untitled concern';
  return compact(`Time-bound concern ready for review: ${subject}`, MAX_ROUTE_TEXT_CHARS);
}

function buildPendingFollowUpContextSummary(request: ConcernRouteRequest): string {
  const provenance = concernRouteProvenanceRefs(request).join(', ');
  const parts = [
    request.summary,
    request.reason ? `Review rationale: ${request.reason}.` : '',
    provenance ? `Provenance: ${provenance}.` : '',
  ].filter(part => part.trim().length > 0);
  return compact(parts.join(' '), MAX_SUMMARY_CHARS);
}

function blockedPendingFollowUpRoute(reason: string): ConcernRouteHandlerResult {
  return {
    disposition: 'blocked',
    substrate: 'pending_follow_up',
    reason: `blocked route: ${reason}`,
  };
}

function normalizeChannelId(channelId: string | undefined): string {
  const trimmed = channelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : CONCERN_ROUTE_SYSTEM_CHANNEL_ID;
}

function compact(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maxChars
    ? compacted
    : `${compacted.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}
