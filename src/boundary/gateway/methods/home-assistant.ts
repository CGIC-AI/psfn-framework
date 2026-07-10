import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  HomeAssistantCallServiceParams,
  HomeAssistantCallServiceResult,
  HomeAssistantCheckConnectionParams,
  HomeAssistantCheckConnectionResult,
  HomeAssistantGetStatesParams,
  HomeAssistantGetStatesResult,
  HomeAssistantState,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { effectiveUrlPort, type UrlPolicyConfig, type UrlPolicyLane } from '../url-policy.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { resolveOptionalEnvCredential } from '../../custody/credential-vault.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  fetchWithValidatedRedirectChain,
  formatFetchFailureDetails,
  loadTlsBundle,
  normalizeRequestHeaders,
  resolveDnsResolver,
  resolveTlsCertPaths,
  withWebCircuit,
  type WebCircuitMethodName,
} from './web.js';

const HOME_ASSISTANT_TOKEN_ENV = 'HOME_ASSISTANT_TOKEN';
const HOME_ASSISTANT_LANE: UrlPolicyLane = 'home_assistant';
const MAX_HA_RESPONSE_BYTES = 1_000_000;
const MAX_HA_REQUEST_BYTES = 64 * 1024;
const MAX_ENTITY_IDS = 50;
const DOMAIN_SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/;
const ENTITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[A-Za-z0-9_]+$/;

function deny(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.POLICY_DENIED);
}

function providerError(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.PROVIDER_ERROR);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function redactHomeAssistantSecrets(message: string, token?: string): string {
  let redacted = message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
  if (token) {
    redacted = redacted.replace(new RegExp(escapeRegExp(token), 'gu'), '[REDACTED]');
  }
  return redacted;
}

function normalizeBaseUrl(runtime: GatewayMethodRuntime): URL {
  const config = runtime.policyConfig.homeAssistant;
  if (config?.enabled !== true) {
    deny('Home Assistant gateway methods are disabled in settings.json (homeAssistantEnabled=false)');
  }

  const rawBaseUrl = config.baseUrl?.trim();
  if (!rawBaseUrl) {
    deny('Home Assistant gateway methods require homeAssistantBaseUrl in settings.json');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    deny('Home Assistant base URL is invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    deny('Home Assistant base URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    deny('Home Assistant base URL must not include credentials');
  }
  if (!parsed.hostname.trim()) {
    deny('Home Assistant base URL must include a host');
  }

  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed;
}

function buildHomeAssistantUrl(baseUrl: URL, apiPath: string): string {
  const basePath = baseUrl.pathname.replace(/\/+$/u, '');
  const url = new URL(baseUrl.toString());
  url.pathname = `${basePath}${apiPath}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function buildHomeAssistantUrlPolicy(baseUrl: URL): UrlPolicyConfig {
  // Pin the allowlist to host AND effective port (Sprint-10 01-M2): a redirect
  // to another port of the Home Assistant host must not stay "in allowlist"
  // and replay the Bearer token. baseUrl.hostname keeps IPv6 brackets, which
  // the allowlist entry parser understands ("[::1]:8123").
  return {
    allowHttp: baseUrl.protocol === 'http:',
    allowInternalNetwork: true,
    hostAllowlist: [`${baseUrl.hostname}:${effectiveUrlPort(baseUrl)}`],
  };
}

function resolveHomeAssistantToken(runtime: GatewayMethodRuntime): string {
  const token = resolveOptionalEnvCredential(
    runtime.credentialVault,
    HOME_ASSISTANT_TOKEN_ENV,
  );
  if (!token) {
    deny(`Home Assistant token is not configured in gateway credential vault (${HOME_ASSISTANT_TOKEN_ENV})`);
  }
  return token;
}

function parseEntityId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    deny(`${field} must be a string`);
  }
  const entityId = value.trim();
  if (!ENTITY_ID_PATTERN.test(entityId) || entityId.length > 128) {
    deny(`${field} must be a valid Home Assistant entity_id`);
  }
  return entityId;
}

function parseOptionalEntityIds(params: HomeAssistantCallServiceParams): string[] {
  const entityIds: string[] = [];
  if (params.entityId !== undefined) {
    entityIds.push(parseEntityId(params.entityId, 'entityId'));
  }
  if (params.entityIds !== undefined) {
    if (!Array.isArray(params.entityIds)) {
      deny('entityIds must be an array of Home Assistant entity_id strings');
    }
    for (const entry of params.entityIds) {
      entityIds.push(parseEntityId(entry, 'entityIds[]'));
    }
  }
  const unique = [...new Set(entityIds)];
  if (unique.length > MAX_ENTITY_IDS) {
    deny(`entityIds exceeds max length (${MAX_ENTITY_IDS})`);
  }
  return unique;
}

function parseDomainOrService(value: unknown, field: 'domain' | 'service'): string {
  if (typeof value !== 'string') {
    deny(`${field} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_SERVICE_PATTERN.test(normalized) || normalized.length > 64) {
    deny(`${field} contains invalid characters`);
  }
  return normalized;
}

function normalizeServiceData(
  params: HomeAssistantCallServiceParams,
  entityIds: readonly string[],
): Record<string, unknown> {
  const rawData = params.data ?? {};
  if (!isRecord(rawData)) {
    deny('data must be an object when provided');
  }
  if (entityIds.length > 0 && Object.hasOwn(rawData, 'entity_id')) {
    deny('entity_id must be provided through entityId/entityIds, not duplicated in data');
  }

  const payload: Record<string, unknown> = { ...rawData };
  if (entityIds.length === 1) {
    payload.entity_id = entityIds[0];
  } else if (entityIds.length > 1) {
    payload.entity_id = [...entityIds];
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  if (encoded.byteLength > MAX_HA_REQUEST_BYTES) {
    deny(`Home Assistant service payload exceeds ${MAX_HA_REQUEST_BYTES} bytes`);
  }
  return payload;
}

async function parseJsonResponse(response: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_HA_RESPONSE_BYTES) {
    providerError(`Home Assistant response exceeded ${MAX_HA_RESPONSE_BYTES} bytes`);
  }
  const raw = bytes.toString('utf8').trim();
  if (!raw) {
    providerError('Home Assistant returned an empty response');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    providerError(`Home Assistant returned malformed JSON: ${toErrorMessage(error)}`);
  }
}

function validateStateRecord(value: unknown, fieldPath: string): HomeAssistantState {
  if (!isRecord(value)) {
    providerError(`Malformed Home Assistant response: ${fieldPath} must be an object`);
  }
  if (typeof value.entity_id !== 'string' || !value.entity_id.trim()) {
    providerError(`Malformed Home Assistant response: ${fieldPath}.entity_id must be a string`);
  }
  if (typeof value.state !== 'string') {
    providerError(`Malformed Home Assistant response: ${fieldPath}.state must be a string`);
  }
  return value as HomeAssistantState;
}

function validateStatesPayload(payload: unknown, entityId: string | undefined): HomeAssistantState[] {
  if (entityId) {
    return [validateStateRecord(payload, 'state')];
  }
  if (!Array.isArray(payload)) {
    providerError('Malformed Home Assistant response: states must be an array');
  }
  return payload.map((entry, index) => validateStateRecord(entry, `states[${index}]`));
}

function validateConnectionPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    providerError('Malformed Home Assistant response: connection check must be an object');
  }
  if (typeof payload.message !== 'string' || !payload.message.trim()) {
    providerError('Malformed Home Assistant response: connection check message must be a string');
  }
  return payload.message;
}

async function requestHomeAssistantJson(
  runtime: GatewayMethodRuntime,
  rpcMethod: WebCircuitMethodName,
  apiPath: string,
  options: {
    method: 'GET' | 'POST';
    body?: Record<string, unknown>;
  },
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(runtime);
  const token = resolveHomeAssistantToken(runtime);
  const url = buildHomeAssistantUrl(baseUrl, apiPath);
  const urlPolicyConfig = buildHomeAssistantUrlPolicy(baseUrl);
  const requestBody = options.body
    ? Buffer.from(JSON.stringify(options.body), 'utf8')
    : undefined;
  const headers = normalizeRequestHeaders({
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
  });

  let tlsCaBundle: string | undefined;
  try {
    tlsCaBundle = loadTlsBundle(resolveTlsCertPaths(runtime));
  } catch (error) {
    providerError(`Home Assistant TLS setup failed: ${formatFetchFailureDetails(error)}`);
  }

  return await withWebCircuit(rpcMethod, HOME_ASSISTANT_LANE, url, async () => {
    let response: Awaited<ReturnType<typeof fetchWithValidatedRedirectChain>>['response'];
    try {
      ({ response } = await fetchWithValidatedRedirectChain(
        rpcMethod,
        url,
        HOME_ASSISTANT_LANE,
        urlPolicyConfig,
        tlsCaBundle,
        headers,
        options.method,
        requestBody,
        MAX_HA_RESPONSE_BYTES,
        runtime,
        resolveDnsResolver(runtime),
      ));
    } catch (error) {
      if (error instanceof JSONRPCErrorException) {
        const redacted = redactHomeAssistantSecrets(error.message, token);
        if (redacted === error.message) {
          throw error;
        }
        throw new JSONRPCErrorException(redacted, error.code, error.data);
      }
      providerError(`Home Assistant request failed: ${
        redactHomeAssistantSecrets(formatFetchFailureDetails(error), token)
      }`);
    }

    if (!response.ok) {
      providerError(`Home Assistant request failed: ${response.status} ${response.statusText}`);
    }
    return await parseJsonResponse(response);
  });
}

async function recordHomeAssistantAudit(
  runtime: GatewayMethodRuntime,
  event: Record<string, unknown>,
  durationMs: number,
  error?: string,
): Promise<void> {
  await runtime.recordAuditEvent?.({
    method: 'home_assistant.action',
    decision: error ? 'DENY' : 'ALLOW',
    params: event,
    durationMs,
    ...(error ? { error } : {}),
  });
}

async function executeHomeAssistantAction<T>(
  runtime: GatewayMethodRuntime,
  event: Record<string, unknown>,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await action();
    await recordHomeAssistantAudit(runtime, { ...event, result: 'success' }, Date.now() - startedAt);
    return result;
  } catch (error) {
    const message = redactHomeAssistantSecrets(toErrorMessage(error));
    await recordHomeAssistantAudit(
      runtime,
      { ...event, result: 'error' },
      Date.now() - startedAt,
      message,
    );
    throw error;
  }
}

function summaryEntity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : undefined;
}

const homeAssistantDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'home_assistant.get_states',
    handler: async (params: HomeAssistantGetStatesParams, runtime): Promise<HomeAssistantGetStatesResult> => {
      const entityId = params.entityId === undefined
        ? undefined
        : parseEntityId(params.entityId, 'entityId');
      const apiPath = entityId
        ? `/api/states/${encodeURIComponent(entityId)}`
        : '/api/states';
      return await executeHomeAssistantAction(
        runtime,
        {
          action: 'get_states',
          entityId: entityId ?? null,
        },
        async () => {
          const payload = await requestHomeAssistantJson(
            runtime,
            'home_assistant.get_states',
            apiPath,
            { method: 'GET' },
          );
          const states = validateStatesPayload(payload, entityId);
          return {
            states,
            count: states.length,
            ...(entityId ? { entityId } : {}),
          };
        },
      );
    },
    summary: (params: HomeAssistantGetStatesParams) => ({
      action: 'get_states',
      entityId: summaryEntity(params.entityId) ?? null,
    }),
    approvalAction: 'home_assistant.read',
    approvalScope: (params: HomeAssistantGetStatesParams) => (
      summaryEntity(params.entityId) ?? 'all_states'
    ),
  },
  {
    name: 'home_assistant.call_service',
    handler: async (
      params: HomeAssistantCallServiceParams,
      runtime,
    ): Promise<HomeAssistantCallServiceResult> => {
      const domain = parseDomainOrService(params.domain, 'domain');
      const service = parseDomainOrService(params.service, 'service');
      const entityIds = parseOptionalEntityIds(params);
      const body = normalizeServiceData(params, entityIds);
      return await executeHomeAssistantAction(
        runtime,
        {
          action: 'call_service',
          domain,
          service,
          entityIds,
        },
        async () => {
          const response = await requestHomeAssistantJson(
            runtime,
            'home_assistant.call_service',
            `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
            { method: 'POST', body },
          );
          return {
            domain,
            service,
            ...(entityIds.length > 0 ? { entityIds } : {}),
            response,
          };
        },
      );
    },
    summary: (params: HomeAssistantCallServiceParams) => ({
      action: 'call_service',
      domain: typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : '<invalid>',
      service: typeof params.service === 'string' ? params.service.trim().toLowerCase() : '<invalid>',
      entityId: summaryEntity(params.entityId) ?? null,
      entityCount: Array.isArray(params.entityIds) ? params.entityIds.length : 0,
      hasData: isRecord(params.data) && Object.keys(params.data).length > 0,
    }),
    approvalAction: 'home_assistant.control',
    approvalScope: (params: HomeAssistantCallServiceParams) => {
      const domain = typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : 'unknown';
      const service = typeof params.service === 'string' ? params.service.trim().toLowerCase() : 'unknown';
      const entity = summaryEntity(params.entityId);
      return entity ? `${domain}.${service}:${entity}` : `${domain}.${service}`;
    },
  },
  {
    name: 'home_assistant.check_connection',
    handler: async (
      _params: HomeAssistantCheckConnectionParams,
      runtime,
    ): Promise<HomeAssistantCheckConnectionResult> => await executeHomeAssistantAction(
      runtime,
      { action: 'check_connection' },
      async () => {
        const payload = await requestHomeAssistantJson(
          runtime,
          'home_assistant.check_connection',
          '/api/',
          { method: 'GET' },
        );
        return {
          ok: true,
          message: validateConnectionPayload(payload),
        };
      },
    ),
    summary: () => ({ action: 'check_connection' }),
    approvalAction: 'home_assistant.read',
    approvalScope: () => 'connection',
  },
];

export function registerHomeAssistantMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, homeAssistantDescriptors);
}
