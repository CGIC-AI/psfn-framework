import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ChatCompletionRequest } from '../types.js';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import {
  resolveSatelliteClaim,
  SATELLITE_CLAIM_HEADERS,
} from '../../backplane/satellite-registry.js';
import type { AuthenticatedHubDeviceConnection } from '../../../boundary/fleet-auth/hub-device-ingress.js';
import { isRecord } from '../../../shared/utils/types.js';

export const HUB_DEVICE_ASSERTION_HEADER = 'x-psfn-hub-device-assertion';
const HUB_SOCKET_CONNECTION_NONCES = new WeakMap<object, string>();

function serverSocketConnectionNonce(req: IncomingMessage): string {
  const current = HUB_SOCKET_CONNECTION_NONCES.get(req.socket);
  if (current) return current;
  const created = randomUUID();
  HUB_SOCKET_CONNECTION_NONCES.set(req.socket, created);
  return created;
}

export class HubDeviceIngressRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    readonly type: string,
    message: string,
    readonly connectionId?: string,
  ) {
    super(message);
    this.name = 'HubDeviceIngressRequestError';
  }
}

export function extractCanonicalHubDeviceAssertion(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const name of url.searchParams.keys()) {
    if ([HUB_DEVICE_ASSERTION_HEADER, 'hub_device_assertion', 'hubdeviceassertion'].includes(name.toLowerCase())) {
      throw new HubDeviceIngressRequestError(400, 'invalid_hub_device_assertion', 'Hub device assertion must use the canonical request header');
    }
  }
  let occurrences = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === HUB_DEVICE_ASSERTION_HEADER) occurrences += 1;
  }
  const raw = req.headers[HUB_DEVICE_ASSERTION_HEADER];
  delete req.headers[HUB_DEVICE_ASSERTION_HEADER];
  if (occurrences !== 1 || Array.isArray(raw) || typeof raw !== 'string' || !raw.trim() || raw.includes(',')) {
    throw new HubDeviceIngressRequestError(401, 'invalid_hub_device_assertion', 'Exactly one Hub device assertion is required');
  }
  if (raw.length > 8192) {
    throw new HubDeviceIngressRequestError(401, 'invalid_hub_device_assertion', 'Hub device assertion is malformed');
  }
  return raw.trim();
}

export function resolveAuthenticatedHubDeviceConnection(input: {
  req: IncomingMessage;
  principal: ApiAuthPrincipal;
  registry?: SatelliteRegistryConfig;
  companionId: string;
  clientCert?: SatelliteClientCertIdentity;
}): AuthenticatedHubDeviceConnection {
  if (input.principal.scope !== 'satellite') {
    throw new HubDeviceIngressRequestError(403, 'hub_device_credential_required', 'An enrolled Hub credential is required');
  }
  const resolved = resolveSatelliteClaim({
    headers: input.req.headers,
    principal: input.principal,
    registry: input.registry,
    ...(input.clientCert ? { clientCert: input.clientCert } : {}),
  });
  if (!resolved.ok) {
    throw new HubDeviceIngressRequestError(
      resolved.status === 503 ? 503 : resolved.status === 400 ? 400 : 403,
      'hub_device_connection_not_admitted',
      'Authenticated Hub device connection was not admitted',
    );
  }
  const satellite = input.registry?.satellites.find(candidate => (
    candidate.satelliteId === resolved.value.satellite.satelliteId
  ));
  const endpoint = satellite?.endpoints.find(candidate => (
    candidate.endpointId === resolved.value.satellite.endpointId
  ));
  const enrollment = endpoint?.hubDeviceEnrollment;
  const connectionId = createHash('sha256').update(JSON.stringify({
    principalId: input.principal.id,
    satelliteId: resolved.value.satellite.satelliteId,
    endpointId: resolved.value.satellite.endpointId,
    sessionId: resolved.value.satellite.sessionId,
    socketConnectionNonce: serverSocketConnectionNonce(input.req),
  })).digest('hex');
  if (!satellite || !endpoint || !enrollment) {
    throw new HubDeviceIngressRequestError(
      403,
      'hub_device_not_enrolled',
      'Authenticated Hub device is not enrolled',
      connectionId,
    );
  }
  return {
    connectionId,
    deviceId: enrollment.deviceId,
    enrollmentVersion: enrollment.enrollmentVersion,
    enrollmentStatus: enrollment.enrollmentStatus,
    companionId: input.companionId,
    sessionId: resolved.value.satellite.sessionId,
    ...(satellite.placeId ? { placeId: satellite.placeId } : {}),
  };
}

const FORBIDDEN_BODY_AUTHORITY_FIELDS = new Set([
  HUB_DEVICE_ASSERTION_HEADER, 'X-PSFN-Hub-Device-Assertion',
  'hub_device_assertion', 'hubDeviceAssertion', 'device_id', 'deviceId',
  'enrollment_version', 'enrollmentVersion', 'enrollment_status', 'enrollmentStatus',
  'companion_id', 'companionId', 'session_id', 'sessionId', 'place_id', 'placeId',
  'human_principal', 'humanPrincipal', 'canonical_contact_id', 'canonicalContactId',
  'author_id', 'authorId', 'author_name', 'authorName',
  'user', 'provider', 'system_prompt',
]);

export function sanitizeHubDeviceChatRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const record = request as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_BODY_AUTHORITY_FIELDS) {
    if (Object.hasOwn(record, key)) {
      throw new HubDeviceIngressRequestError(400, 'conflicting_hub_device_authority', 'Caller-provided Hub device authority is not allowed');
    }
  }
  if (request.system_prompt_mode && request.system_prompt_mode !== 'default') {
    throw new HubDeviceIngressRequestError(400, 'conflicting_hub_device_authority', 'Hub device turns may not bypass the companion prompt');
  }
  delete record.satellite_claim;
  delete record.channel_metadata;
  for (const message of request.messages) {
    if (isRecord(message)) delete message.name;
  }
  return request;
}

const DOWNSTREAM_SECRET_OR_IDENTITY_HEADERS = [
  'authorization', 'cookie', HUB_DEVICE_ASSERTION_HEADER,
  'x-author-id', 'x-author-name', 'x-channel-id', 'x-channel-type',
  'x-channel-privacy', 'x-thread-id',
  'x-psfn-author-id', 'x-psfn-author-name', 'x-psfn-channel-id',
  'x-psfn-channel-type', 'x-session-id', 'x-canonical-contact-id',
  'x-identity-claim-channel', 'x-identity-claim-user-id', 'x-identity-claim-nonce',
  'x-identity-claim-expires', 'x-identity-claim-signature',
  'x-psfn-trusted-proxy-token',
] as const;

export function stripHubDeviceDownstreamAuthorityHeaders(req: IncomingMessage): void {
  for (const name of DOWNSTREAM_SECRET_OR_IDENTITY_HEADERS) delete req.headers[name];
  // Retain only server-resolved satellite claim headers needed by the agent.
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith('x-identity-claim-')) delete req.headers[name];
    if (name.startsWith('x-psfn-client-cert-')) delete req.headers[name];
  }
  if (!req.headers[SATELLITE_CLAIM_HEADERS.sessionId]) {
    throw new HubDeviceIngressRequestError(400, 'invalid_hub_device_connection', 'Hub device session binding is missing');
  }
}
