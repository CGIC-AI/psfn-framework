import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TrustedHostPasskeyCeremonyService } from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import { TrustedHostPasskeyCeremonyError } from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import {
  FleetAuthBrokerError,
  type GatewayFleetAuthBroker,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { FLEET_AUTH_SESSION_COOKIE_NAME } from './fleet-auth-cookie.js';

export const FLEET_AUTH_PASSKEY_START_PATH = '/v1/fleet-auth/passkeys/registration/start';
export const FLEET_AUTH_PASSKEY_FINISH_PATH = '/v1/fleet-auth/passkeys/registration/finish';
export const FLEET_AUTH_FIRST_OWNER_COMPLETE_PATH = '/v1/fleet-auth/first-owner/complete';

const PATHS = new Set([
  FLEET_AUTH_PASSKEY_START_PATH,
  FLEET_AUTH_PASSKEY_FINISH_PATH,
  FLEET_AUTH_FIRST_OWNER_COMPLETE_PATH,
]);

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function clearSessionCookie(): string {
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function sessionCookie(token: string, absoluteExpiresAt: Date, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now) / 1000));
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof TrustedHostPasskeyCeremonyError) {
    throw new FleetAuthBrokerError(
      error.code,
      error.code === 'origin_mismatch' ? 403
        : error.code === 'invalid_request' ? 400 : 409,
      error.message,
    );
  }
  throw new FleetAuthBrokerError(
    'invalid_passkey_ceremony_request',
    400,
    'Passkey ceremony request is malformed',
  );
}

/** Same-origin browser adapter; trusted-host creation remains CLI-only. */
export class FleetAuthPasskeyHttpRoutes {
  constructor(private readonly options: {
    ceremonies: Pick<TrustedHostPasskeyCeremonyService,
      'startRegistration' | 'finishRegistration'>;
    broker: Pick<GatewayFleetAuthBroker, 'completeFirstOwnerBootstrap'>;
  }) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && PATHS.has(path);
  }

  async handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    path: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    const body = await readJsonBodyWithLimit(input.request, input.response, { maxBytes: 1_100_000 });
    if (!body.ok) return;
    try {
      if (!isRecord(body.value)) throw new Error('Passkey request body must be an object');
      if (input.path === FLEET_AUTH_PASSKEY_START_PATH) {
        assertNoUnknownKeys(body.value, ['nonce', 'kind'], 'passkeyStart');
        const kind = requiredString(body.value, 'kind');
        if (kind !== 'first_owner' && kind !== 'passkey_enrollment'
          && kind !== 'passkey_recovery') {
          throw new Error('Passkey ceremony kind is invalid');
        }
        const started = await this.options.ceremonies.startRegistration({
          nonce: requiredString(body.value, 'nonce'),
          kind,
          token: input.token,
          csrfToken: input.csrfToken,
          requestOrigin: input.requestOrigin,
        });
        sendJson(input.response, 200, started, { 'Cache-Control': 'no-store' });
        return;
      }
      if (input.path === FLEET_AUTH_PASSKEY_FINISH_PATH) {
        assertNoUnknownKeys(body.value, ['nonce', 'kind', 'response'], 'passkeyFinish');
        const kind = requiredString(body.value, 'kind');
        if (kind !== 'passkey_enrollment' && kind !== 'passkey_recovery') {
          throw new Error('Passkey credential ceremony kind is invalid');
        }
        const completed = await this.options.ceremonies.finishRegistration({
          nonce: requiredString(body.value, 'nonce'),
          kind,
          token: input.token,
          csrfToken: input.csrfToken,
          requestOrigin: input.requestOrigin,
          response: body.value.response,
        });
        input.response.setHeader('Set-Cookie', clearSessionCookie());
        sendJson(input.response, 200, {
          ...completed,
          reauthenticationRequired: true,
        }, { 'Cache-Control': 'no-store' });
        return;
      }
      assertNoUnknownKeys(body.value, ['nonce', 'response'], 'firstOwnerComplete');
      const session = await this.options.broker.completeFirstOwnerBootstrap({
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
        assuranceEvidence: {
          nonce: requiredString(body.value, 'nonce'),
          response: body.value.response,
        },
      });
      input.response.setHeader('Set-Cookie', sessionCookie(
        session.token,
        session.absoluteExpiresAt,
      ));
      sendJson(input.response, 200, {
        csrfToken: session.csrfToken,
        principalStatus: session.principalStatus,
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      translate(error);
    }
  }
}
