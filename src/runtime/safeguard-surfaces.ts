import {
  createExternalCommunicationRateLimiterFromEnv,
  createIdentityCoolingOffManagerFromEnv,
  createLifecycleRestartSafeguardFromEnv,
  createSafeguardAuditTrail,
} from '../system/capabilities/safeguards.js';

export interface RuntimeSafeguardSurfaces {
  safeguardAuditTrail: ReturnType<typeof createSafeguardAuditTrail>;
  identityCoolingOff: ReturnType<typeof createIdentityCoolingOffManagerFromEnv>;
  lifecycleRestartSafeguard: ReturnType<typeof createLifecycleRestartSafeguardFromEnv>;
  externalRateLimiter: ReturnType<typeof createExternalCommunicationRateLimiterFromEnv>;
}

export function createRuntimeSafeguardSurfaces(
  companionDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSafeguardSurfaces {
  const safeguardAuditTrail = createSafeguardAuditTrail(companionDataDir);
  return {
    safeguardAuditTrail,
    identityCoolingOff: createIdentityCoolingOffManagerFromEnv(env, {
      auditTrail: safeguardAuditTrail,
    }),
    lifecycleRestartSafeguard: createLifecycleRestartSafeguardFromEnv(env, {
      auditTrail: safeguardAuditTrail,
    }),
    externalRateLimiter: createExternalCommunicationRateLimiterFromEnv(env, {
      auditTrail: safeguardAuditTrail,
    }),
  };
}
