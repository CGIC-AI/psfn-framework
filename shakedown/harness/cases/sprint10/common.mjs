import { createHash } from 'node:crypto';

export function envText(env, name, fallback = '') {
  const value = env?.[name];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function requireCaseEnv(env, names, caseId) {
  const missing = names.filter((name) => !envText(env, name));
  if (missing.length > 0) {
    throw new Error(`${caseId} requires ${missing.join(', ')}`);
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

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function proof(source, assertion) {
  return { source, assertion };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeCustomOutcome({
  sessionId,
  request,
  response,
  turnRecord,
  sideChecks,
}) {
  return {
    sessionId,
    busyRetries: 0,
    submitAttempts: 1,
    busyRejected: false,
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
