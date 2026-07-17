import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FleetJitStepUpError,
  type FleetJitRequestBinding,
  type FleetJitStepUpCoordinator,
} from '../../../boundary/fleet-auth/jit-step-up.js';
import { compileGatewayGardenRequestTarget } from '../../../boundary/fleet-auth/request-capability-target.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  LOWERCASE_RFC4122_COMPANION_ID_PATTERN,
  createCompanionId,
} from '../../../shared/routing/companion-id.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { parseMemorySubjectJitRequest } from '../../../shared/contracts/memory-subject-jit.js';
import {
  isPrivacyBreakGlassConfirmRoute,
  parsePrivacyBreakGlassConfirmRequest,
  privacyBreakGlassPurpose,
  privacyBreakGlassResourceKindForRoute,
  privacyBreakGlassSubjectScopeDigest,
} from '../../../shared/contracts/privacy-break-glass.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';

export const FLEET_AUTH_JIT_WEBAUTHN_START_PATH = '/v1/fleet-auth/jit/webauthn/start';
export const FLEET_AUTH_JIT_WEBAUTHN_FINISH_PATH = '/v1/fleet-auth/jit/webauthn/finish';
export const FLEET_AUTH_JIT_DISCORD_START_PATH = '/v1/fleet-auth/jit/discord/start';
export const FLEET_AUTH_JIT_DISCORD_FINISH_PATH = '/v1/fleet-auth/jit/discord/finish';
export const FLEET_AUTH_JIT_CANCEL_PATH = '/v1/fleet-auth/jit/cancel';

const JIT_PATHS = new Set([
  FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
  FLEET_AUTH_JIT_WEBAUTHN_FINISH_PATH,
  FLEET_AUTH_JIT_DISCORD_START_PATH,
  FLEET_AUTH_JIT_DISCORD_FINISH_PATH,
  FLEET_AUTH_JIT_CANCEL_PATH,
]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

function routeBodyLimit(path: string): number {
  return path.endsWith('/start') ? 17_000_000 : 1_100_000;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function requestBinding(value: unknown): FleetJitRequestBinding {
  if (!isRecord(value)) throw new Error('JIT start body must be an object');
  assertNoUnknownKeys(value, [
    'companionId',
    'method',
    'target',
    'bodyBase64url',
    'subjectScopeDigest',
    'purpose',
    'memoryRevision',
    'classifierEvidenceDigest',
  ], 'jitStart');
  const companionId = requiredString(value, 'companionId');
  const method = requiredString(value, 'method');
  const rawTarget = requiredString(value, 'target');
  const bodyBase64url = requiredString(value, 'bodyBase64url');
  if (!LOWERCASE_RFC4122_COMPANION_ID_PATTERN.test(companionId)
    || !BASE64URL_PATTERN.test(bodyBase64url)) {
    throw new Error('JIT start binding is malformed');
  }
  const body = Buffer.from(bodyBase64url, 'base64url');
  if (body.toString('base64url') !== bodyBase64url) {
    throw new Error('JIT body bytes are not canonically encoded');
  }
  const target = compileGatewayGardenRequestTarget({
    rawTarget,
    method,
    companionId: createCompanionId(companionId),
    body,
  });
  if (target.action === 'privacy.break_glass') {
    const resourceKind = privacyBreakGlassResourceKindForRoute(target.resource.routeId);
    const resourceId = target.resource.pathParams.id;
    if (!isPrivacyBreakGlassConfirmRoute(target.resource.routeId)
      || target.authorization.requirements.assurance !== 'privacy_break_glass'
      || !resourceKind || !resourceId
      || value.subjectScopeDigest !== undefined
      || value.purpose !== undefined
      || value.memoryRevision !== undefined
      || value.classifierEvidenceDigest !== undefined) {
      throw new Error('Privacy break-glass JIT must bind one exact confirmation resource');
    }
    const request = parsePrivacyBreakGlassConfirmRequest(JSON.parse(body.toString('utf8')));
    return {
      target,
      subjectScopeDigest: privacyBreakGlassSubjectScopeDigest({
        companionId,
        action: target.action,
        routeId: target.resource.routeId,
        resourceKind,
        resourceId,
      }),
      purpose: privacyBreakGlassPurpose(request),
      memoryRevision: 1,
      classifierEvidenceDigest: target.resourceDigest,
    };
  }
  const subjectScopeDigest = requiredString(value, 'subjectScopeDigest');
  const purpose = requiredString(value, 'purpose');
  const classifierEvidenceDigest = requiredString(value, 'classifierEvidenceDigest');
  if (!DIGEST_PATTERN.test(subjectScopeDigest)
    || !DIGEST_PATTERN.test(classifierEvidenceDigest)
    || !Number.isSafeInteger(value.memoryRevision)
    || Number(value.memoryRevision) < 1) {
    throw new Error('JIT start binding is malformed');
  }
  if (target.action === 'memory.jit.self') {
    if (target.resource.routeId !== 'POST /api/admin/memory/:id/reveal') {
      throw new Error('Memory JIT must bind one exact reveal resource');
    }
    const memoryBinding = parseMemorySubjectJitRequest(JSON.parse(body.toString('utf8')));
    if (!timingSafeStringEqual(memoryBinding.subjectScopeDigest, subjectScopeDigest)
      || memoryBinding.purpose !== purpose.trim()
      || memoryBinding.memoryRevision !== Number(value.memoryRevision)
      || !timingSafeStringEqual(
        memoryBinding.classifierEvidenceDigest,
        classifierEvidenceDigest,
      )) {
      throw new Error('Memory JIT target body does not match its durable binding');
    }
  }
  return {
    target,
    subjectScopeDigest,
    purpose,
    memoryRevision: Number(value.memoryRevision),
    classifierEvidenceDigest,
  };
}

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof FleetJitStepUpError) {
    const status = error.code === 'origin_mismatch' ? 403
      : error.code === 'lower_assurance_unavailable' ? 503
        : error.code === 'strong_assurance_required' ? 403
          : error.code === 'invalid_request' ? 400
            : 409;
    throw new FleetAuthBrokerError(error.code, status, error.message);
  }
  throw new FleetAuthBrokerError('invalid_jit_request', 400, 'JIT step-up request is malformed');
}

/** Strict same-origin HTTP adapter; all authority remains in the coordinator/store. */
export class FleetAuthJitHttpRoutes {
  constructor(private readonly coordinator: Pick<FleetJitStepUpCoordinator,
    | 'startWebAuthn'
    | 'finishWebAuthn'
    | 'startDiscordPossession'
    | 'finishDiscordPossession'
    | 'cancel'>) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && JIT_PATHS.has(path);
  }

  async handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    path: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    const body = await readJsonBodyWithLimit(input.request, input.response, {
      maxBytes: routeBodyLimit(input.path),
    });
    if (!body.ok) return;
    try {
      if (input.path === FLEET_AUTH_JIT_WEBAUTHN_START_PATH
        || input.path === FLEET_AUTH_JIT_DISCORD_START_PATH) {
        const binding = requestBinding(body.value);
        const started = input.path === FLEET_AUTH_JIT_WEBAUTHN_START_PATH
          ? await this.coordinator.startWebAuthn({
            token: input.token,
            csrfToken: input.csrfToken,
            requestOrigin: input.requestOrigin,
            binding,
          })
          : await this.coordinator.startDiscordPossession({
            token: input.token,
            csrfToken: input.csrfToken,
            requestOrigin: input.requestOrigin,
            binding,
          });
        sendJson(input.response, 200, started, { 'Cache-Control': 'no-store' });
        return;
      }
      if (!isRecord(body.value)) throw new Error('JIT completion body must be an object');
      if (input.path === FLEET_AUTH_JIT_WEBAUTHN_FINISH_PATH) {
        assertNoUnknownKeys(
          body.value,
          ['challengeId', 'requestNonce', 'response'],
          'jitWebAuthnFinish',
        );
        const completed = await this.coordinator.finishWebAuthn({
          challengeId: requiredString(body.value, 'challengeId'),
          requestNonce: requiredString(body.value, 'requestNonce'),
          token: input.token,
          csrfToken: input.csrfToken,
          requestOrigin: input.requestOrigin,
          response: body.value.response,
        });
        sendJson(input.response, 200, completed, { 'Cache-Control': 'no-store' });
        return;
      }
      if (input.path === FLEET_AUTH_JIT_DISCORD_FINISH_PATH) {
        assertNoUnknownKeys(
          body.value,
          ['challengeId', 'requestNonce', 'approvalCode'],
          'jitDiscordFinish',
        );
        const completed = await this.coordinator.finishDiscordPossession({
          challengeId: requiredString(body.value, 'challengeId'),
          requestNonce: requiredString(body.value, 'requestNonce'),
          approvalCode: requiredString(body.value, 'approvalCode'),
          token: input.token,
          csrfToken: input.csrfToken,
          requestOrigin: input.requestOrigin,
        });
        sendJson(input.response, 200, completed, { 'Cache-Control': 'no-store' });
        return;
      }
      assertNoUnknownKeys(body.value, ['challengeId'], 'jitCancel');
      await this.coordinator.cancel({
        challengeId: requiredString(body.value, 'challengeId'),
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
      });
      input.response.statusCode = 204;
      input.response.end();
    } catch (error) {
      translate(error);
    }
  }
}
