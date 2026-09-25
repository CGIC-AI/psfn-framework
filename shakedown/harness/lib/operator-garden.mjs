// Operator Garden credential for harness maintenance actions (xpgnr).
//
// Some harness actions are OPERATOR maintenance on the companion, not test
// cases: sweeping stale harness prompt markers before a run and restoring
// prompt layers byte-identically after a prompt case. Prompt layers are the
// companion's identity material, so the synthetic testing-harness Garden door
// deliberately cannot hold `prompts.manage` (its bounded action list excludes
// identity-mutating and break-glass actions). On kube these actions therefore
// go through the audited ADMIN_TOKEN operator door at the same unified origin
// (/companions/<id>/garden/api/admin/...), which records every capability it
// mints as an `admin_token_operator` authorization audit row.
//
// Fail closed: on kube the operator token is required and must be independent
// of the testing-harness key; there is no fallback to the harness credential.

import { InvalidEnvError, requireEnvOneOf } from './env.mjs';

export const OPERATOR_GARDEN_TOKEN_ENV = ['PSFN_OPERATOR_ADMIN_TOKEN', 'ADMIN_TOKEN', 'PSFN_ADMIN_TOKEN'];

/**
 * Resolve the Garden credential for operator maintenance. Local targets
 * already authenticate Garden with the standalone ADMIN_TOKEN, so they reuse
 * it; kube targets require the independent ADMIN_TOKEN operator credential.
 */
export function resolveOperatorGardenToken(target, env = process.env) {
  if (!target.isKube) return target.adminToken;
  const token = requireEnvOneOf(
    OPERATOR_GARDEN_TOKEN_ENV,
    'ADMIN_TOKEN operator credential for harness prompt maintenance on the unified origin',
    env,
  );
  if (token === target.apiKey) {
    throw new InvalidEnvError(
      'PSFN_OPERATOR_ADMIN_TOKEN',
      'the operator Garden credential must be independent from TESTING_HARNESS_API_KEY',
    );
  }
  return token;
}

/** Bearer headers for an operator maintenance request (explicit, never inferred). */
export function operatorGardenHeaders(operatorToken, body) {
  return {
    Authorization: `Bearer ${operatorToken}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
}
