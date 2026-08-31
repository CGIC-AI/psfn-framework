import {
  InvalidEnvError,
  optionalEnv,
  requireEnvOneOf,
} from './env.mjs';

/**
 * Resolve the independent Operator authority used by HITL approval cases.
 *
 * Conversational traffic may authenticate with the fleet SSO testing-harness
 * key, but confirmation resolution is a private gateway operation. The
 * standard shakedown ADMIN_TOKEN is therefore resolved separately and is never
 * inferred from the target's Garden credential.
 */
export function resolveOperatorApprovalTarget(target, env = process.env) {
  const adminToken = requireEnvOneOf(
    ['PSFN_OPERATOR_ADMIN_TOKEN', 'ADMIN_TOKEN', 'PSFN_ADMIN_TOKEN'],
    'independent Operator confirmation token',
    env,
  );
  if (adminToken === target.apiKey) {
    throw new InvalidEnvError(
      'PSFN_OPERATOR_ADMIN_TOKEN',
      'Operator approval authority must be independent from TESTING_HARNESS_API_KEY',
    );
  }
  const defaultApiBaseUrl = `${target.chatBaseUrl.replace(/\/$/u, '')}/v1`;
  return {
    apiBaseUrl: optionalEnv('PSFN_OPERATOR_API_BASE', defaultApiBaseUrl, env),
    adminToken,
  };
}

/**
 * Preflight Operator authority when the full catalog or an HITL case is
 * selected. Focused non-HITL runs do not need access to the private resolver.
 */
export function resolveOperatorApprovalTargetForCases(
  target,
  { caseIds, phase },
  env = process.env,
) {
  const selectedExplicitly = caseIds.has('memory_delete_restore');
  const selectedByPhase = caseIds.size === 0 && phase === 'autonomous';
  if (!selectedExplicitly && !selectedByPhase) return null;
  return resolveOperatorApprovalTarget(target, env);
}
