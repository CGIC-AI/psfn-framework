import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseAccountReapprovalProviderProof,
  TrustedHostAccountReapprovalError,
  type TrustedHostAccountReapprovalService,
} from '../../../boundary/fleet-auth/trusted-host-account-reapproval.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { FLEET_AUTH_SESSION_COOKIE_NAME } from './fleet-auth-cookie.js';

export const FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH =
  '/v1/fleet-auth/account-reapproval/webauthn/start';
export const FLEET_AUTH_ACCOUNT_REAPPROVAL_FINISH_PATH =
  '/v1/fleet-auth/account-reapproval/webauthn/finish';

const PATHS = new Set([
  FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH,
  FLEET_AUTH_ACCOUNT_REAPPROVAL_FINISH_PATH,
]);

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function clearSessionCookie(): string {
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof TrustedHostAccountReapprovalError) {
    throw new FleetAuthBrokerError(
      error.code,
      error.code === 'origin_mismatch' ? 403
        : error.code === 'invalid_request' ? 400 : 409,
      error.message,
    );
  }
  throw new FleetAuthBrokerError(
    'invalid_account_reapproval_request',
    400,
    'Account reapproval request is malformed',
  );
}

/** Authenticated same-origin adapter; trusted-host ceremony creation is CLI-only. */
export class FleetAuthAccountReapprovalHttpRoutes {
  constructor(private readonly service: Pick<TrustedHostAccountReapprovalService,
    'startAuthentication' | 'finishAuthentication'>) {}

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
      if (!isRecord(body.value)) throw new Error('Account reapproval body must be an object');
      if (input.path === FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH) {
        assertNoUnknownKeys(body.value, ['nonce', 'providerProof'], 'accountReapprovalStart');
      } else {
        assertNoUnknownKeys(
          body.value,
          ['nonce', 'providerProof', 'response'],
          'accountReapprovalFinish',
        );
      }
      const common = {
        nonce: requiredString(body.value, 'nonce'),
        providerProof: parseAccountReapprovalProviderProof(body.value.providerProof),
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
      };
      if (input.path === FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH) {
        const started = await this.service.startAuthentication(common);
        sendJson(input.response, 200, started, { 'Cache-Control': 'no-store' });
        return;
      }
      const completed = await this.service.finishAuthentication({
        ...common,
        response: body.value.response,
      });
      input.response.setHeader('Set-Cookie', clearSessionCookie());
      sendJson(input.response, 200, completed, { 'Cache-Control': 'no-store' });
    } catch (error) {
      translate(error);
    }
  }
}
