import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TrustedHostProviderRecoveryError,
  type ProviderRecoveryOAuthProof,
  type TrustedHostProviderRecoveryService,
} from '../../../boundary/fleet-auth/trusted-host-provider-recovery.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { FLEET_AUTH_SESSION_COOKIE_NAME } from './fleet-auth-cookie.js';

export const FLEET_AUTH_PROVIDER_RECOVERY_START_PATH =
  '/v1/fleet-auth/provider-recovery/webauthn/start';
export const FLEET_AUTH_PROVIDER_RECOVERY_FINISH_PATH =
  '/v1/fleet-auth/provider-recovery/webauthn/finish';

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function proof(value: unknown): ProviderRecoveryOAuthProof {
  if (!isRecord(value)) throw new Error('newProvider must be an object');
  assertNoUnknownKeys(
    value,
    ['provider', 'subjectId', 'callbackTransactionId', 'proofDigest'],
    'newProvider',
  );
  if (value.provider !== 'discord') throw new Error('newProvider.provider is invalid');
  return {
    provider: value.provider,
    subjectId: requiredString(value, 'subjectId'),
    callbackTransactionId: requiredString(value, 'callbackTransactionId'),
    proofDigest: requiredString(value, 'proofDigest'),
  };
}

function clearSessionCookie(): string {
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof TrustedHostProviderRecoveryError) {
    throw new FleetAuthBrokerError(
      error.code,
      error.code === 'origin_mismatch' ? 403
        : error.code === 'invalid_request' ? 400 : 409,
      error.message,
    );
  }
  throw new FleetAuthBrokerError(
    'invalid_provider_recovery_request',
    400,
    'Provider recovery request is malformed',
  );
}

/** Same-origin browser completion; trusted-host creation remains CLI-only. */
export class FleetAuthProviderRecoveryHttpRoutes {
  constructor(private readonly recovery: Pick<TrustedHostProviderRecoveryService, 'start' | 'finish'>) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST'
      && (path === FLEET_AUTH_PROVIDER_RECOVERY_START_PATH
        || path === FLEET_AUTH_PROVIDER_RECOVERY_FINISH_PATH);
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
      if (!isRecord(body.value)) throw new Error('Provider recovery body must be an object');
      const commonKeys = ['oneTimeCredential', 'confirmation', 'reason', 'newProvider'] as const;
      assertNoUnknownKeys(
        body.value,
        input.path === FLEET_AUTH_PROVIDER_RECOVERY_FINISH_PATH
          ? [...commonKeys, 'response']
          : commonKeys,
        'providerRecovery',
      );
      const common = {
        oneTimeCredential: requiredString(body.value, 'oneTimeCredential'),
        confirmation: requiredString(body.value, 'confirmation'),
        reason: requiredString(body.value, 'reason'),
        newProvider: proof(body.value.newProvider),
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
      };
      if (input.path === FLEET_AUTH_PROVIDER_RECOVERY_START_PATH) {
        sendJson(input.response, 200, await this.recovery.start(common), {
          'Cache-Control': 'no-store',
        });
        return;
      }
      const completed = await this.recovery.finish({ ...common, response: body.value.response });
      input.response.setHeader('Set-Cookie', clearSessionCookie());
      sendJson(input.response, 200, {
        ...completed,
        reauthenticationRequired: true,
      }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      translate(error);
    }
  }
}
