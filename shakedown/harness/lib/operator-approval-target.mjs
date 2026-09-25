import {
  InvalidEnvError,
  optionalEnv,
  requireEnvOneOf,
} from './env.mjs';

const RFC4122_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  // A fleet gateway resolves confirmations per companion and rejects a body
  // without companionId. The kube target always names its fleet companion; the
  // single-companion local target names none and resolves as the standalone
  // Operator.
  const companionId = target.companionId ?? null;
  if (companionId !== null && !RFC4122_UUID_PATTERN.test(companionId)) {
    throw new InvalidEnvError('COMPANION_ID', 'Operator approval companionId must be an RFC 4122 UUID');
  }
  return {
    apiBaseUrl: optionalEnv('PSFN_OPERATOR_API_BASE', defaultApiBaseUrl, env),
    adminToken,
    companionId,
  };
}

/**
 * Build the private Operator confirmation-resolution request. The fleet
 * gateway requires the target companionId; it is included whenever the
 * approval target names one.
 */
export function buildOperatorConfirmationApproval(approvalTarget, confirmationId) {
  return {
    url: `${approvalTarget.apiBaseUrl.replace(/\/$/u, '')}/operator/confirmations/resolve`,
    headers: {
      Authorization: `Bearer ${approvalTarget.adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: confirmationId,
      decision: 'approve',
      ...(approvalTarget.companionId ? { companionId: approvalTarget.companionId } : {}),
    }),
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
