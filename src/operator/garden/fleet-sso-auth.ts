import type { IncomingMessage } from 'node:http';
import {
  digestGardenRouteAuthorization,
  type ValidatedGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  stripBrowserRequestCapabilityHeaders,
} from '../../boundary/fleet-auth/request-capability-transport.js';
import type {
  RequestCapabilityVerifier,
  VerifiedRequestCapability,
} from '../../boundary/fleet-auth/request-capability.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';

const CAPABILITY_HEADER = 'x-psfn-request-capability';
const AUDIENCE_HEADER = 'x-psfn-capability-audience';
const REQUEST_ID_HEADER = 'x-psfn-capability-request-id';
const DECISION_HEADER = 'x-psfn-capability-decision';
const JTI_HEADER = 'x-psfn-capability-jti';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class GardenFleetSsoAuthenticationError extends Error {
  constructor(message: string) {
    super(`Garden fleet SSO authentication rejected: ${message}`);
    this.name = 'GardenFleetSsoAuthenticationError';
  }
}

/**
 * Authenticate the exact gateway-authored operator capability. Browser
 * cookies/bearers never count as Garden authority, and all capability headers
 * are deleted immediately after verification so the parent assertion cannot
 * cross the operator-to-agent hop.
 */
export function authenticateGardenFleetSsoRequest(input: {
  request: IncomingMessage;
  metadata: ValidatedGardenRequestMetadata;
  companionId: CompanionId;
  verifier: RequestCapabilityVerifier;
}): VerifiedRequestCapability {
  const { request } = input;
  try {
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined
      || request.headers['proxy-authorization'] !== undefined
      || request.headers['transfer-encoding'] !== undefined) {
      throw new GardenFleetSsoAuthenticationError('browser credential or ambiguous body metadata present');
    }
    const token = singleHeader(request.headers[CAPABILITY_HEADER]);
    const audience = singleHeader(request.headers[AUDIENCE_HEADER]);
    const requestId = singleHeader(request.headers[REQUEST_ID_HEADER]);
    const decisionId = singleHeader(request.headers[DECISION_HEADER]);
    const jti = singleHeader(request.headers[JTI_HEADER]);
    const rawLength = singleHeader(request.headers['content-length']);
    const bodyLength = rawLength === undefined ? 0 : Number(rawLength);
    if (!token || !audience || !requestId || !decisionId || !jti
      || !Number.isSafeInteger(bodyLength) || bodyLength < 0) {
      throw new GardenFleetSsoAuthenticationError('capability envelope is incomplete');
    }
    const verified = input.verifier.verifyOperatorTransport({
      token,
      companionId: input.companionId,
      method: input.metadata.method,
      canonicalRequestTarget: input.metadata.canonicalRequestTarget,
      action: input.metadata.action,
      authorizationDigest: digestGardenRouteAuthorization(input.metadata.authorization),
      bodyLength,
      requestId,
      decisionId,
    });
    if (audience !== verified.audience || jti !== verified.jti) {
      throw new GardenFleetSsoAuthenticationError('capability routing metadata changed');
    }
    return verified;
  } finally {
    stripBrowserRequestCapabilityHeaders(request.headers);
  }
}
