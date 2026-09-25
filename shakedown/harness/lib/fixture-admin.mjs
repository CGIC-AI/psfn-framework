import { resolveOperatorApprovalTarget } from './operator-approval-target.mjs';

/**
 * Bearer for harness-owned fixture sweeps and restores (prompt layers,
 * harness skills, contact notes). On kube the testing-harness Garden door is
 * deliberately limited (no prompts.manage, skills or contacts writes), so
 * those sweeps returned 404 and aborted Layer A (psfn-framework-xpgnr). They
 * use the independent Operator ADMIN_TOKEN door instead, the same authority
 * HITL approval already requires; it must differ from the testing-harness key.
 * The local target keeps its Garden admin token.
 */
export function resolveFixtureAdminToken(target, env = process.env) {
  if (!target.isKube) return target.adminToken;
  return resolveOperatorApprovalTarget(target, env).adminToken;
}
