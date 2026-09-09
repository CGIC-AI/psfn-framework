import { randomUUID } from 'node:crypto';
import type {
  HomeAssistantCallServiceParams,
  HomeAssistantCallServiceResult,
  HomeAssistantCheckConnectionParams,
  HomeAssistantCheckConnectionResult,
  HomeAssistantGetStatesParams,
  HomeAssistantGetStatesResult,
  HomeAssistantState,
} from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { defineGatedMethod } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { gatewayMethodParamDecoders } from './params.js';
import { isRecord } from '../../../shared/utils/types.js';
import { worldAutonomyLimiter } from '../world-autonomy-limiter.js';
import { denyPolicy as deny, providerError, requestSatelliteHub } from './satellite-hub-transport.js';

const MAX_ENTITY_IDS = 50;
const ENTITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[A-Za-z0-9_]+$/u;
const DOMAIN_SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/u;
const ALLOWED_DOMAINS = new Set(['light', 'fan', 'switch', 'media_player']);
const ALLOWED_SERVICES = new Set(['turn_on', 'turn_off', 'toggle']);
const ALLOWED_INTENTS = new Set(['direct', 'presence_enter', 'presence_exit', 'attention', 'sleep', 'wake']);

/** Home Assistant methods ride the shared Hub transport and require HA to be enabled. */
async function requestHub(
  runtime: GatewayMethodRuntime,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<unknown> {
  return requestSatelliteHub(runtime, path, method, body, { requireHomeAssistant: true });
}

function parseEntityId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ENTITY_ID_PATTERN.test(value.trim()) || value.trim().length > 128) {
    deny(`${field} must be a valid Home Assistant entity_id`);
  }
  return value.trim();
}

function parseEntityIds(params: HomeAssistantCallServiceParams): string[] {
  const ids = [
    ...(params.entityId === undefined ? [] : [parseEntityId(params.entityId, 'entityId')]),
    ...(Array.isArray(params.entityIds)
      ? params.entityIds.map((entry) => parseEntityId(entry, 'entityIds[]'))
      : []),
  ];
  if (params.entityIds !== undefined && !Array.isArray(params.entityIds)) deny('entityIds must be an array');
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > MAX_ENTITY_IDS) {
    deny(`entityIds must contain 1-${MAX_ENTITY_IDS} entries`);
  }
  return unique;
}

function parseToken(value: unknown, field: string): string {
  if (typeof value !== 'string') deny(`${field} must be a string`);
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_SERVICE_PATTERN.test(normalized) || normalized.length > 64) deny(`${field} is invalid`);
  return normalized;
}

function resolveRegisteredAffordance(runtime: GatewayMethodRuntime, params: HomeAssistantCallServiceParams): void {
  const placeId = params.placeId.trim();
  const affordanceId = params.affordanceId.trim();
  if (!placeId || !affordanceId) deny('world control requires placeId and affordanceId');
  const place = runtime.policyConfig.homeAssistant?.placesRegistry?.places
    .find((candidate) => candidate.placeId === placeId);
  const affordance = place?.affordances.find((candidate) => candidate.affordanceId === affordanceId);
  if (!place || !affordance || affordance.role !== 'effector' || affordance.backend !== 'ha') {
    deny('world control target is not a registered Home Assistant effector');
  }
  const entityIds = parseEntityIds(params);
  if (!affordance.entityId || entityIds.length !== 1 || entityIds[0] !== affordance.entityId) {
    deny('world control entity does not match the registered affordance');
  }
  const entityDomain = affordance.entityId.split('.')[0];
  if (entityDomain !== params.domain) deny('world control domain does not match the registered entity');
  if (affordance.kind !== params.domain && !(affordance.kind === 'light' && params.domain === 'switch')) {
    deny('world control domain is incompatible with affordance kind');
  }
  const command = params.service === 'turn_on' ? 'on' : params.service === 'turn_off' ? 'off' : 'toggle';
  if (affordance.control && !affordance.control.includes(command)) {
    deny('world control command is not allowed by the registered affordance');
  }
}

function parseStates(payload: unknown): HomeAssistantState[] {
  if (!isRecord(payload) || !Array.isArray(payload.states)) providerError('Malformed Satellite Hub states response');
  return payload.states.map((state) => {
    if (!isRecord(state) || typeof state.entity_id !== 'string' || typeof state.state !== 'string') {
      providerError('Malformed Satellite Hub state record');
    }
    return state as HomeAssistantState;
  });
}

const descriptors = [
  defineGatedMethod<HomeAssistantGetStatesParams, HomeAssistantGetStatesResult>({
    name: 'home_assistant.get_states',
    decode: gatewayMethodParamDecoders['home_assistant.get_states'],
    handler: async (params: HomeAssistantGetStatesParams, runtime): Promise<HomeAssistantGetStatesResult> => {
      const entityIds = params.entityId === undefined ? [] : [parseEntityId(params.entityId, 'entityId')];
      const payload = await requestHub(runtime, '/internal/v1/home-assistant/states', 'POST', { entityIds });
      const states = parseStates(payload);
      return { states, count: states.length, ...(params.entityId ? { entityId: params.entityId } : {}) };
    },
    summary: (params: HomeAssistantGetStatesParams) => ({ action: 'get_states', entityId: params.entityId ?? null }),
    approvalAction: 'home_assistant.read',
    approvalScope: (params: HomeAssistantGetStatesParams) => params.entityId ?? 'all_states',
  }),
  defineGatedMethod<HomeAssistantCallServiceParams, HomeAssistantCallServiceResult>({
    name: 'home_assistant.call_service',
    decode: gatewayMethodParamDecoders['home_assistant.call_service'],
    handler: async (params: HomeAssistantCallServiceParams, runtime): Promise<HomeAssistantCallServiceResult> => {
      const domain = parseToken(params.domain, 'domain');
      const service = parseToken(params.service, 'service');
      if (!ALLOWED_DOMAINS.has(domain) || !ALLOWED_SERVICES.has(service)) deny('world control domain or service is not allowed');
      if (typeof params.reason !== 'string' || !params.reason.trim() || params.reason.trim().length > 240) {
        deny('world control requires a reason of at most 240 characters');
      }
      if (typeof params.intent !== 'string' || !ALLOWED_INTENTS.has(params.intent)) {
        deny('world control requires a recognized intent');
      }
      resolveRegisteredAffordance(runtime, { ...params, domain, service });
      const entityIds = parseEntityIds(params);
      if (runtime.policyConfig.homeAssistant?.autonomousControlEnabled === true) {
        worldAutonomyLimiter.authorize(`${params.placeId}:${params.affordanceId}`);
      }
      if (params.data !== undefined && !isRecord(params.data)) deny('data must be an object');
      const payload = await requestHub(runtime, '/internal/v1/home-assistant/call-service', 'POST', {
        requestId: params.requestId?.trim() || randomUUID(),
        domain,
        service,
        entityIds,
        ...(params.data ? { data: params.data } : {}),
      });
      return { domain, service, entityIds, response: payload };
    },
    summary: (params: HomeAssistantCallServiceParams) => ({
      action: 'call_service',
      placeId: params.placeId,
      affordanceId: params.affordanceId,
      domain: params.domain,
      service: params.service,
      intent: params.intent ?? null,
      reason: params.reason.slice(0, 240),
    }),
    approvalAction: 'home_assistant.control',
    approvalScope: (params: HomeAssistantCallServiceParams) => `${params.placeId}:${params.affordanceId}`,
  }),
  defineGatedMethod<HomeAssistantCheckConnectionParams, HomeAssistantCheckConnectionResult>({
    name: 'home_assistant.check_connection',
    decode: gatewayMethodParamDecoders['home_assistant.check_connection'],
    handler: async (_params: HomeAssistantCheckConnectionParams, runtime): Promise<HomeAssistantCheckConnectionResult> => {
      const payload = await requestHub(runtime, '/internal/v1/home-assistant/health', 'GET');
      if (!isRecord(payload) || payload.connected !== true || payload.status !== 'ready') {
        providerError('Satellite Hub Home Assistant transport is not ready');
      }
      return { ok: true, message: 'Satellite Hub Home Assistant transport is ready' };
    },
    summary: () => ({ action: 'check_connection' }),
    approvalAction: 'home_assistant.read',
    approvalScope: () => 'connection',
  }),
];

export function registerHomeAssistantMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, descriptors);
}
