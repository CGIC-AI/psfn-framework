import type { NorthStarStore } from '../../faculties/north-star/store.js';
import type { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import {
  CONCERN_ROUTE_SYSTEM_CHANNEL_ID,
  concernRouteProvenanceRefs,
  type ConcernRouteHandler,
  type ConcernRouteHandlerResult,
  type ConcernRouteRequest,
} from './concern-route-handoff.js';

const MAX_ROUTE_TEXT_CHARS = 500;

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
          reason: `blocked route: north-star handoff failed (${errorMessage(error)})`,
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
          reason: `blocked route: reflection-journal handoff failed (${errorMessage(error)})`,
        };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
