import { createHash } from 'node:crypto';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { SatelliteCapability, SatelliteTelemetryScope } from '../../shared/contracts/satellite-registry.js';
import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import type { CompiledGardenRequestTarget } from './request-capability-target.js';
import type { GardenRouteAuthorization } from './garden-route-authorization.js';
import { FLEET_AUTH_ACTION_BASE_ROLE } from './role-action-policy.js';
import { PRIMARY_EMBODIMENT_HANDOFF_REASONS } from './primary-embodiment.js';

export const COMPANION_UI_ACTION_RESOURCES = [
  'conversation.status',
  'conversation.interact',
  'conversation.interrupt',
  'conversation.touch',
  'conversation.audio',
  'confirmations.list',
  'confirmations.resolve',
  'artifact.preview',
  'tool_activity.subscribe',
  'embodiment.status',
  'embodiment.handoff',
] as const;

export type CompanionUiActionResource = typeof COMPANION_UI_ACTION_RESOURCES[number];

export const COMPANION_UI_PROTOCOL_LIMITS = Object.freeze({
  maxFrameBytes: 1_048_576,
  maxTextCharacters: 65_536,
  maxArtifactIdCharacters: 200,
});

const RESOURCE_ACTION: Readonly<Record<CompanionUiActionResource, FleetAuthAction>> = Object.freeze({
  'conversation.status': 'companion.read',
  'conversation.interact': 'companion.interact',
  'conversation.interrupt': 'companion.interact',
  'conversation.touch': 'companion.interact',
  'conversation.audio': 'companion.interact',
  'confirmations.list': 'confirmations.read',
  'confirmations.resolve': 'confirmations.resolve',
  'artifact.preview': 'artifacts.read',
  'tool_activity.subscribe': 'tool_activity.read',
  'embodiment.status': 'companion.read',
  'embodiment.handoff': 'embodiment.handoff',
});

function physicalCeiling(
  capabilities: readonly SatelliteCapability[],
  telemetryScopes: readonly SatelliteTelemetryScope[],
): Readonly<{ capabilities: readonly SatelliteCapability[]; telemetryScopes: readonly SatelliteTelemetryScope[] }> {
  return Object.freeze({ capabilities: Object.freeze([...capabilities]), telemetryScopes: Object.freeze([...telemetryScopes]) });
}

const RESOURCE_PHYSICAL_CEILING: Readonly<Record<CompanionUiActionResource, Readonly<{
  capabilities: readonly SatelliteCapability[];
  telemetryScopes: readonly SatelliteTelemetryScope[];
}>>> = Object.freeze({
  'conversation.status': physicalCeiling([], ['status']),
  'conversation.interact': physicalCeiling(['text'], []),
  'conversation.interrupt': physicalCeiling(['audio_output'], []),
  'conversation.touch': physicalCeiling(['touch'], []),
  'conversation.audio': physicalCeiling(['audio_input', 'speech_to_text'], []),
  'confirmations.list': physicalCeiling([], ['approvals']),
  'confirmations.resolve': physicalCeiling([], ['approvals']),
  'artifact.preview': physicalCeiling([], ['artifacts']),
  'tool_activity.subscribe': physicalCeiling([], ['tool_activity']),
  'embodiment.status': physicalCeiling([], []),
  'embodiment.handoff': physicalCeiling([], []),
});

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'assertion', 'audience', 'capability', 'channel', 'channelid', 'companion', 'companionid',
  'contact', 'contactid', 'device', 'deviceid', 'enrollment', 'enrollmentversion', 'human',
  'humanprincipal', 'identity', 'place', 'placeid', 'principal', 'principalid', 'provider',
  'requestcapability', 'session', 'sessionid', 'trusted', 'trustlevel', 'user',
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE_SET = new Set<string>(COMPANION_UI_ACTION_RESOURCES);
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type CompanionUiActionBody =
  | Readonly<Record<string, never>>
  | Readonly<{ content: string }>
  | Readonly<{ interactionId: string }>
  | Readonly<{ region: 'head' | 'face' | 'shoulder' | 'hand'; count: number; durationMs: number }>
  | Readonly<{ transcript: string }>
  | Readonly<{ id: string; decision: 'approve' | 'deny' }>
  | Readonly<{ id: string }>
  | Readonly<{ subscribe: true }>
  | Readonly<{
    expectedGeneration: number;
    decisionId: string;
    reason: typeof PRIMARY_EMBODIMENT_HANDOFF_REASONS[number];
  }>;

export interface CompanionUiActionFrame {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly action: FleetAuthAction;
  readonly resource: CompanionUiActionResource;
  readonly body: CompanionUiActionBody;
}

export interface CompanionUiPhysicalCapabilityCeiling {
  readonly capabilities: readonly SatelliteCapability[];
  readonly telemetryScopes: readonly SatelliteTelemetryScope[];
}

export interface CompiledCompanionUiAction {
  readonly frame: CompanionUiActionFrame;
  readonly target: CompiledGardenRequestTarget;
  readonly physicalCeiling: Readonly<{
    capabilities: readonly SatelliteCapability[];
    telemetryScopes: readonly SatelliteTelemetryScope[];
  }>;
}

export class CompanionUiProtocolError extends Error {
  constructor(readonly code: 'invalid_frame' | 'authority_forbidden' | 'physical_capability_denied') {
    super('Companion UI action was denied');
    this.name = 'CompanionUiProtocolError';
  }
}

function deny(code: CompanionUiProtocolError['code'] = 'invalid_frame'): never {
  throw new CompanionUiProtocolError(code);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

function rejectAuthorityFields(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
      if (FORBIDDEN_AUTHORITY_FIELDS.has(normalized)) deny('authority_forbidden');
      pending.push(child);
    }
  }
}

function parseEmptyBody(value: unknown): Readonly<Record<string, never>> {
  if (!isRecord(value) || Object.keys(value).length !== 0) deny();
  return Object.freeze({});
}

function parseBody(resource: CompanionUiActionResource, value: unknown): CompanionUiActionBody {
  if (!isRecord(value)) deny();
  switch (resource) {
    case 'conversation.status':
    case 'confirmations.list':
    case 'embodiment.status':
      return parseEmptyBody(value);
    case 'conversation.interact':
      if (!hasExactKeys(value, ['content']) || typeof value.content !== 'string'
        || value.content.length === 0 || value.content.length > COMPANION_UI_PROTOCOL_LIMITS.maxTextCharacters) deny();
      return Object.freeze({ content: value.content });
    case 'conversation.interrupt':
      if (!hasExactKeys(value, ['interactionId']) || typeof value.interactionId !== 'string'
        || !REQUEST_ID_PATTERN.test(value.interactionId)) deny();
      return Object.freeze({ interactionId: value.interactionId });
    case 'conversation.touch':
      if (!hasExactKeys(value, ['region', 'count', 'durationMs'])
        || !['head', 'face', 'shoulder', 'hand'].includes(String(value.region))
        || !Number.isSafeInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 16
        || !Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0 || Number(value.durationMs) > 60_000) deny();
      return Object.freeze({
        region: value.region as 'head' | 'face' | 'shoulder' | 'hand',
        count: Number(value.count),
        durationMs: Number(value.durationMs),
      });
    case 'conversation.audio':
      if (!hasExactKeys(value, ['transcript']) || typeof value.transcript !== 'string'
        || value.transcript.length === 0 || value.transcript.length > COMPANION_UI_PROTOCOL_LIMITS.maxTextCharacters) deny();
      return Object.freeze({ transcript: value.transcript });
    case 'confirmations.resolve':
      if (!hasExactKeys(value, ['id', 'decision']) || typeof value.id !== 'string'
        || !ARTIFACT_ID_PATTERN.test(value.id)
        || (value.decision !== 'approve' && value.decision !== 'deny')) deny();
      return Object.freeze({ id: value.id, decision: value.decision });
    case 'artifact.preview':
      if (!hasExactKeys(value, ['id']) || typeof value.id !== 'string'
        || value.id.length > COMPANION_UI_PROTOCOL_LIMITS.maxArtifactIdCharacters
        || !ARTIFACT_ID_PATTERN.test(value.id)) deny();
      return Object.freeze({ id: value.id });
    case 'tool_activity.subscribe':
      if (!hasExactKeys(value, ['subscribe']) || value.subscribe !== true) deny();
      return Object.freeze({ subscribe: true as const });
    case 'embodiment.handoff':
      if (!hasExactKeys(value, ['expectedGeneration', 'decisionId', 'reason'])
        || !Number.isSafeInteger(value.expectedGeneration) || Number(value.expectedGeneration) < 0
        || typeof value.decisionId !== 'string' || !isRfc4122Uuid(value.decisionId)
        || !PRIMARY_EMBODIMENT_HANDOFF_REASONS.includes(
          value.reason as typeof PRIMARY_EMBODIMENT_HANDOFF_REASONS[number],
        )) deny();
      return Object.freeze({
        expectedGeneration: Number(value.expectedGeneration),
        decisionId: value.decisionId,
        reason: value.reason as typeof PRIMARY_EMBODIMENT_HANDOFF_REASONS[number],
      });
  }
}

export function parseCompanionUiActionFrame(rawBody: Uint8Array): CompanionUiActionFrame {
  if (rawBody.byteLength === 0 || rawBody.byteLength > COMPANION_UI_PROTOCOL_LIMITS.maxFrameBytes) deny();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
  } catch {
    return deny();
  }
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'requestId', 'action', 'resource', 'body'])
    || value.schemaVersion !== 1 || typeof value.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(value.requestId) || typeof value.resource !== 'string'
    || !RESOURCE_SET.has(value.resource)) deny();
  rejectAuthorityFields(value.body);
  const resource = value.resource as CompanionUiActionResource;
  const expectedAction = RESOURCE_ACTION[resource];
  if (value.action !== expectedAction) deny();
  return Object.freeze({
    schemaVersion: 1,
    requestId: value.requestId,
    action: expectedAction,
    resource,
    body: parseBody(resource, value.body),
  });
}

function authorizationFor(resource: CompanionUiActionResource): GardenRouteAuthorization {
  const action = RESOURCE_ACTION[resource];
  const area = resource.startsWith('confirmations.') ? 'confirmations'
    : resource === 'artifact.preview' ? 'channel_artifacts'
      : resource === 'tool_activity.subscribe' ? 'telemetry'
        : resource.startsWith('embodiment.') ? 'companion'
        : 'companion';
  return Object.freeze({
    action,
    baseRole: FLEET_AUTH_ACTION_BASE_ROLE[action],
    resource: Object.freeze({ scope: 'garden_surface', area }),
    subjectRelation: 'current_companion',
    requirements: Object.freeze({
      assurance: 'oauth',
      confirmation: resource === 'confirmations.resolve' || resource === 'embodiment.handoff'
        ? 'explicit'
        : 'none',
      approvals: Object.freeze([]),
    }),
    publicAccess: 'never',
    recoveryAccess: 'forbidden',
  });
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function companionUiActionRouteId(resource: CompanionUiActionResource): string {
  return `COMPANION_UI ${resource}`;
}

export function companionUiActionPath(companionId: string, resource: CompanionUiActionResource): string {
  return `/companion-ui/companions/${companionId}/ws/actions/${resource}`;
}

/** Exact prompt text for the three prompt-bearing action resources. */
export function companionUiPromptContent(frame: CompanionUiActionFrame): string | undefined {
  const body = frame.body as Record<string, unknown>;
  if (frame.resource === 'conversation.interact') return String(body.content);
  if (frame.resource === 'conversation.audio') return String(body.transcript);
  if (frame.resource === 'conversation.touch') {
    return `[Authenticated device touch: region=${String(body.region)}, count=${String(body.count)}, durationMs=${String(body.durationMs)}]`;
  }
  return undefined;
}

export function resolveCompanionUiActionClassification(
  method: string,
  canonicalPath: string,
): { resource: CompanionUiActionResource; authorization: GardenRouteAuthorization; routeId: string } | undefined {
  if (method !== 'WS') return undefined;
  const match = /^\/companion-ui\/companions\/([0-9a-f-]+)\/ws\/actions\/([a-z_.]+)$/u.exec(canonicalPath);
  if (!match || !isRfc4122Uuid(match[1]) || !RESOURCE_SET.has(match[2])) return undefined;
  const resource = match[2] as CompanionUiActionResource;
  return Object.freeze({ resource, authorization: authorizationFor(resource), routeId: companionUiActionRouteId(resource) });
}

export function compileCompanionUiAction(
  rawBody: Uint8Array,
  companionId: CompanionId,
  ceiling: CompanionUiPhysicalCapabilityCeiling,
): CompiledCompanionUiAction {
  const frame = parseCompanionUiActionFrame(rawBody);
  const required = RESOURCE_PHYSICAL_CEILING[frame.resource];
  if (required.capabilities.some(capability => !ceiling.capabilities.includes(capability))
    || required.telemetryScopes.some(scope => !ceiling.telemetryScopes.includes(scope))) {
    deny('physical_capability_denied');
  }
  const authorization = authorizationFor(frame.resource);
  const bodyDigest = digest(rawBody);
  const canonicalPath = companionUiActionPath(companionId, frame.resource);
  const resource = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'garden_route' as const,
    routeId: companionUiActionRouteId(frame.resource),
    scope: authorization.resource.scope,
    area: authorization.resource.area,
    companionId,
    pathParams: Object.freeze({ companionId, resource: frame.resource }),
    query: Object.freeze({}),
    bodyDigest,
  });
  const resourceDigest = digest(JSON.stringify(resource));
  const authorizationDigest = digest(JSON.stringify(authorization));
  const targetDigest = digest(JSON.stringify({
    schemaVersion: 1,
    method: 'WS',
    canonicalRequestTarget: canonicalPath,
    companionId,
    action: frame.action,
    authorizationDigest,
    resourceDigest,
  }));
  const target: CompiledGardenRequestTarget = Object.freeze({
    schemaVersion: 1,
    method: 'WS',
    canonicalPath,
    canonicalQuery: '',
    canonicalRequestTarget: canonicalPath,
    companionId,
    action: frame.action,
    authorization,
    resource,
    bodyDigest,
    bodyLength: rawBody.byteLength,
    resourceDigest,
    authorizationDigest,
    targetDigest,
    body: rawBody,
  });
  return Object.freeze({
    frame,
    target,
    physicalCeiling: Object.freeze({
      capabilities: Object.freeze([...ceiling.capabilities]),
      telemetryScopes: Object.freeze([...ceiling.telemetryScopes]),
    }),
  });
}
