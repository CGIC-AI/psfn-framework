import type { ServerResponse } from 'node:http';
import type { Logger } from 'winston';

export type GardenDenialReasonCode =
  | 'browser_authority_forbidden'
  | 'capability_already_consumed'
  | 'capability_context_invalid'
  | 'capability_invalid'
  | 'capability_replay_mismatch'
  | 'capability_required'
  | 'capability_testing_harness_disabled'
  | 'child_assertion_denied'
  | 'escalation_grant_required'
  | 'feature_off'
  | 'fleet_authorization_denied'
  | 'fleet_target_not_found'
  | 'garden_service_response_denied'
  | 'internal_model_usage_admission_failed'
  | 'internal_model_usage_denied'
  | 'internal_model_usage_scope_denied'
  | 'invalid_capability_headers'
  | 'public_route_authority_forbidden'
  | 'replay_authority_unavailable'
  | 'request_body_forbidden'
  | 'request_body_required'
  | 'request_body_too_large'
  | 'request_target_invalid'
  | 'route_not_declared'
  | 'subject_authorized_memory_required'
  | 'subject_bound_session_required'
  | 'transport_peer_forbidden'
  | 'websocket_route_denied';

export interface GardenDenialDetails {
  reasonCode: GardenDenialReasonCode;
  reason?: string;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  routeId?: string;
  action?: string;
  principalId?: string;
  errorName?: string;
  response?: ServerResponse;
}

export type GardenDenialLogger = Pick<Logger, 'warn'>;

const denialCountsBySecond = new Map<number, number>();
const loggedResponses = new WeakSet<ServerResponse>();

function pruneGardenDenials(now: number): void {
  const cutoffSecond = Math.ceil((now - (60 * 60 * 1_000)) / 1_000);
  for (const second of denialCountsBySecond.keys()) {
    if (second < cutoffSecond) denialCountsBySecond.delete(second);
  }
}

export function recordGardenDenial(
  logger: GardenDenialLogger,
  details: GardenDenialDetails,
): void {
  const now = Date.now();
  pruneGardenDenials(now);
  const second = Math.floor(now / 1_000);
  denialCountsBySecond.set(second, (denialCountsBySecond.get(second) ?? 0) + 1);
  if (details.response) loggedResponses.add(details.response);
  logger.warn('Fleet Garden request denied', {
    reasonCode: details.reasonCode,
    reason: details.reason ?? details.reasonCode,
    status: details.status,
    routeId: details.routeId ?? 'unresolved',
    action: details.action ?? 'unresolved',
    principalId: details.principalId ?? 'unknown',
    ...(details.errorName ? { errorName: details.errorName } : {}),
  });
}

export function hasRecordedGardenDenial(response: ServerResponse): boolean {
  return loggedResponses.has(response);
}

export function getGardenDenialsLastHour(now = Date.now()): number {
  pruneGardenDenials(now);
  let total = 0;
  for (const count of denialCountsBySecond.values()) total += count;
  return total;
}

export function clearGardenDenialsForTests(): void {
  denialCountsBySecond.clear();
}

export function getGardenDenialBucketCountForTests(): number {
  return denialCountsBySecond.size;
}
