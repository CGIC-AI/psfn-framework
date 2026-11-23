import type { NorthStarStore } from '../../faculties/north-star/store.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { Awaitable } from '../../shared/utils/types.js';
import type { PendingFollowUpStorePort } from './pending-follow-up-store-port.js';
import { boundContextSummary } from './context-summary.js';
import {
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
          ...optionalContextSummary(buildPendingFollowUpContextSummary(request)),
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

function buildPendingFollowUpReviewText(request: ConcernRouteRequest): string {
  const subject = request.title.trim() || request.summary.trim() || 'untitled concern';
  return compact(`Time-bound concern ready for review: ${subject}`, MAX_ROUTE_TEXT_CHARS);
}

function buildPendingFollowUpContextSummary(request: ConcernRouteRequest): string | undefined {
  const provenance = concernRouteProvenanceRefs(request).join(', ');
  const parts = [
    request.summary,
    request.reason ? `Review rationale: ${request.reason}.` : '',
    provenance ? `Provenance: ${provenance}.` : '',
  ].filter(part => part.trim().length > 0);
  return boundContextSummary(parts.join(' '));
}

function optionalContextSummary(contextSummary: string | undefined): { contextSummary?: string } {
  return contextSummary ? { contextSummary } : {};
}

function blockedPendingFollowUpRoute(reason: string): ConcernRouteHandlerResult {
  return {
    disposition: 'blocked',
    substrate: 'pending_follow_up',
    reason: `blocked route: ${reason}`,
  };
}

function compact(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maxChars
    ? compacted
    : `${compacted.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}
