import { createHash } from 'node:crypto';

import { InvalidEnvError, MissingEnvError, requireEnv } from '../../lib/env.mjs';
import { deriveApiKeyPrincipalId } from '../../lib/probe.mjs';

export function envText(env, name, fallback = '') {
  const value = env?.[name];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function requireCaseEnv(env, names, caseId) {
  const missing = names.filter((name) => !envText(env, name));
  if (missing.length > 0) {
    throw new MissingEnvError(
      missing[0],
      `${caseId} requires ${missing.join(', ')}`,
    );
  }
}

function satelliteEnvNames(prefix) {
  return {
    claimType: `${prefix}_CLAIM_TYPE`,
    satelliteId: `${prefix}_ID`,
    endpointId: `${prefix}_ENDPOINT_ID`,
    sessionId: `${prefix}_SESSION_ID`,
    capabilities: `${prefix}_CAPABILITIES`,
    telemetryScopes: `${prefix}_TELEMETRY_SCOPES`,
  };
}

export function satelliteHeaders(env, prefix) {
  const names = satelliteEnvNames(prefix);
  return {
    'X-PSFN-Satellite-Claim-Type': envText(env, names.claimType),
    'X-PSFN-Satellite-ID': envText(env, names.satelliteId),
    'X-PSFN-Satellite-Endpoint-ID': envText(env, names.endpointId),
    'X-PSFN-Satellite-Session-ID': envText(env, names.sessionId),
    ...(envText(env, names.capabilities)
      ? { 'X-PSFN-Satellite-Capabilities': envText(env, names.capabilities) }
      : {}),
    ...(envText(env, names.telemetryScopes)
      ? { 'X-PSFN-Satellite-Telemetry-Scopes': envText(env, names.telemetryScopes) }
      : {}),
  };
}

export function requireSatelliteEnv(env, prefix, caseId) {
  const names = satelliteEnvNames(prefix);
  requireCaseEnv(
    env,
    [names.claimType, names.satelliteId, names.endpointId, names.sessionId],
    caseId,
  );
}

export function issueHubDeviceAssertionHeaders({
  services,
  env,
  prefix,
  caseId,
}) {
  requireSatelliteEnv(env, prefix, caseId);
  requireCaseEnv(env, ['COMPANION_ID'], caseId);
  if (typeof services.issueHubDeviceAssertion !== 'function') {
    throw new Error(`${caseId} requires the canonical Hub device assertion issuer`);
  }
  const assertion = services.issueHubDeviceAssertion({
    companionId: envText(env, 'COMPANION_ID'),
    satelliteId: envText(env, `${prefix}_ID`),
    endpointId: envText(env, `${prefix}_ENDPOINT_ID`),
    sessionId: envText(env, `${prefix}_SESSION_ID`),
  });
  return { 'X-PSFN-Hub-Device-Assertion': assertion };
}

export function requireSatelliteDispatchAuth(env, prefix, caseId) {
  const variable = `${prefix}_API_KEY`;
  const apiKey = requireEnv(
    variable,
    `${caseId} requires the enrolled per-satellite bearer`,
    env,
  );
  if (apiKey.length < 16) {
    throw new InvalidEnvError(
      variable,
      `${caseId} requires an enrolled bearer of at least 16 characters`,
    );
  }
  return {
    apiKey,
    apiUserId: deriveApiKeyPrincipalId(apiKey),
  };
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function proof(source, assertion) {
  return { source, assertion };
}

export { sleep } from '../../lib/probe.mjs';

export function normalizeCustomOutcome({
  sessionId,
  apiUserId,
  request,
  response,
  turnRecord,
  sideChecks,
  busyObservedAtMs,
}) {
  return {
    sessionId,
    ...(typeof apiUserId === 'string' && apiUserId.length > 0 ? { apiUserId } : {}),
    busyRetries: 0,
    submitAttempts: 1,
    busyRejected: false,
    busyObservedAtMs: typeof busyObservedAtMs === 'number' ? busyObservedAtMs : null,
    acceptedWhileBusy: false,
    resolvedFromTurnRecord: Boolean(turnRecord),
    request,
    response,
    turnRecord,
    sideChecks,
  };
}

export function artifactContainsEvent(entries, eventId) {
  return entries.some((entry) => JSON.stringify(entry).includes(`eventId=${eventId}`));
}
