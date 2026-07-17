import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import type { GatewayTrustedHostGardenRecoveryService } from '../../../boundary/gateway/trusted-host-garden-recovery.js';
import { TrustedHostGardenRecoveryError } from '../../../boundary/gateway/trusted-host-garden-recovery.js';
import {
  TRUSTED_HOST_RECOVERY_ACTION,
  trustedHostRecoveryResource,
} from '../../../boundary/fleet-auth/request-capability.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { sendJson } from '../../backplane/http/primitives.js';

export const FLEET_AUTH_RECOVERY_ISSUE_PATH =
  '/v1/fleet-auth/garden-recovery/capabilities/issue';
export const FLEET_AUTH_RECOVERY_CONSUME_PATH =
  '/v1/fleet-auth/garden-recovery/capabilities/consume';
export const FLEET_AUTH_RECOVERY_REVOKE_PATH =
  '/v1/fleet-auth/garden-recovery/credentials/revoke';
export const FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER =
  'x-psfn-trusted-host-recovery-credential';

const RECOVERY_PROTOCOL_LIMITS = Object.freeze({
  // Code-owned wire/DoS ceiling: the compact capability is bounded at 64 KiB
  // and the exact typed scope adds less than 6 KiB of JSON framing.
  bodyBytes: 70 * 1_024,
});
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'forwarded',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

class RecoveryRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'RecoveryRouteError';
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const rawCount = request.rawHeaders.reduce((count, header, index) => (
    index % 2 === 0 && header.toLowerCase() === name ? count + 1 : count
  ), 0);
  const value = request.headers[name];
  return rawCount === 1 && typeof value === 'string' ? value : undefined;
}

function assertTrustedHostTransport(request: IncomingMessage, url: URL): string {
  const credential = singleHeader(request, FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER);
  delete request.headers[FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER];
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER) {
      request.rawHeaders.splice(index, 2);
    }
  }
  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress !== '127.0.0.1'
    && remoteAddress !== '::1'
    && remoteAddress !== '::ffff:127.0.0.1') {
    throw new RecoveryRouteError(403, 'trusted_host_required', 'Recovery requires loopback transport');
  }
  const host = singleHeader(request, 'host');
  let hostname = '';
  try {
    hostname = host ? new URL(`http://${host}`).hostname : '';
  } catch {
    hostname = '';
  }
  if (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== 'localhost') {
    throw new RecoveryRouteError(403, 'trusted_host_required', 'Recovery requires an exact trusted host');
  }
  if (url.search !== '') {
    throw new RecoveryRouteError(400, 'recovery_query_forbidden', 'Recovery endpoints do not accept query data');
  }
  for (const header of Object.keys(request.headers)) {
    if (FORBIDDEN_HEADERS.has(header) || header.startsWith('sec-fetch-')) {
      throw new RecoveryRouteError(403, 'browser_or_proxy_forbidden', 'Recovery transport metadata was rejected');
    }
  }
  if (singleHeader(request, 'content-type') !== 'application/json'
    || request.headers['content-encoding'] !== undefined
    || request.headers['transfer-encoding'] !== undefined) {
    throw new RecoveryRouteError(415, 'recovery_content_type_invalid', 'Recovery requires exact JSON bytes');
  }
  if (!credential || credential.length > 8_192 || /[\r\n\u0000]/u.test(credential)) {
    throw new RecoveryRouteError(403, 'recovery_credential_rejected', 'Recovery credential was rejected');
  }
  return credential;
}

async function readExactJson(request: IncomingMessage): Promise<{
  readonly raw: Buffer;
  readonly value: unknown;
}> {
  const rawLength = singleHeader(request, 'content-length');
  if (!rawLength || !/^(?:0|[1-9][0-9]{0,5})$/u.test(rawLength)) {
    throw new RecoveryRouteError(411, 'recovery_content_length_required', 'Exact Content-Length is required');
  }
  const expectedLength = Number(rawLength);
  if (expectedLength < 2 || expectedLength > RECOVERY_PROTOCOL_LIMITS.bodyBytes) {
    throw new RecoveryRouteError(413, 'recovery_body_too_large', 'Recovery request body is invalid');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > expectedLength || length > RECOVERY_PROTOCOL_LIMITS.bodyBytes) {
      throw new RecoveryRouteError(400, 'recovery_body_length_mismatch', 'Recovery body length changed');
    }
    chunks.push(bytes);
  }
  if (length !== expectedLength) {
    throw new RecoveryRouteError(400, 'recovery_body_length_mismatch', 'Recovery body length changed');
  }
  const raw = Buffer.concat(chunks, length);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw new RecoveryRouteError(400, 'recovery_json_invalid', 'Recovery JSON is invalid');
  }
  return { raw, value };
}

function parseScope(value: unknown, consume: boolean): {
  readonly companionId: string;
  readonly action: 'recovery.begin';
  readonly resource: ReturnType<typeof trustedHostRecoveryResource>;
  readonly reason: string;
  readonly token?: string;
} {
  if (!isRecord(value)) {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery request is malformed');
  }
  try {
    assertNoUnknownKeys(
      value,
      consume
        ? ['companionId', 'action', 'resource', 'reason', 'token']
        : ['companionId', 'action', 'resource', 'reason'],
      'recovery request',
    );
  } catch {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery request is malformed');
  }
  if (typeof value.companionId !== 'string'
    || value.action !== TRUSTED_HOST_RECOVERY_ACTION
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || value.reason.length > 1_024
    || value.reason.trim() !== value.reason
    || (consume && (typeof value.token !== 'string' || value.token.length > 65_536))) {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery request is malformed');
  }
  let resource;
  try {
    resource = trustedHostRecoveryResource(value.companionId);
  } catch {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery request is malformed');
  }
  if (!isRecord(value.resource)) {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery resource is not exact');
  }
  try {
    assertNoUnknownKeys(
      value.resource,
      ['schemaVersion', 'kind', 'routeId', 'scope', 'area', 'companionId'],
      'recovery resource',
    );
  } catch {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery resource is not exact');
  }
  if (value.resource.schemaVersion !== resource.schemaVersion
    || value.resource.kind !== resource.kind
    || value.resource.routeId !== resource.routeId
    || value.resource.scope !== resource.scope
    || value.resource.area !== resource.area
    || value.resource.companionId !== resource.companionId) {
    throw new RecoveryRouteError(400, 'recovery_request_invalid', 'Recovery resource is not exact');
  }
  return {
    companionId: value.companionId,
    action: TRUSTED_HOST_RECOVERY_ACTION,
    resource,
    reason: value.reason,
    ...(consume ? { token: value.token as string } : {}),
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof RecoveryRouteError) {
    sendJson(response, error.status, { error: { type: error.code, message: error.message } });
    return;
  }
  if (error instanceof TrustedHostGardenRecoveryError) {
    const status = error.code === 'recovery_replay_mismatch'
      || error.code === 'recovery_authority_changed'
      ? 409
      : error.code === 'recovery_request_invalid' ? 400 : 403;
    sendJson(response, status, { error: { type: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    error: { type: 'trusted_host_recovery_failed', message: 'Trusted-host recovery failed' },
  });
}

export class FleetAuthRecoveryHttpRoutes {
  constructor(private readonly recovery: GatewayTrustedHostGardenRecoveryService) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && (
      path === FLEET_AUTH_RECOVERY_ISSUE_PATH
      || path === FLEET_AUTH_RECOVERY_CONSUME_PATH
      || path === FLEET_AUTH_RECOVERY_REVOKE_PATH
    );
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const credential = assertTrustedHostTransport(request, url);
      const body = await readExactJson(request);
      const isConsume = url.pathname === FLEET_AUTH_RECOVERY_CONSUME_PATH;
      const scope = parseScope(body.value, isConsume);
      if (url.pathname === FLEET_AUTH_RECOVERY_ISSUE_PATH) {
        sendJson(response, 201, await this.recovery.issue({ ...scope, credential }));
        return;
      }
      if (isConsume) {
        const transportDigest = createHash('sha256').update(body.raw).digest('hex');
        sendJson(response, 200, await this.recovery.consume({
          ...scope,
          credential,
          token: scope.token!,
          transportDigest,
        }));
        return;
      }
      sendJson(response, 200, await this.recovery.revoke({ ...scope, credential }));
    } catch (error) {
      if (!response.writableEnded) sendError(response, error);
    }
  }
}
