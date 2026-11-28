import type { ConfirmationResolveRequest } from '../../system/capabilities/confirmation-queue.js';
import { isRecord } from '../../shared/utils/types.js';

const CONFIRMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const DECISION_KEYS = ['id', 'decision', 'modifiedParams'] as const;

/**
 * Strict gateway wire form of one operator confirmation decision. Every
 * gateway door that resolves the approval queue parses through this so an
 * unknown key, malformed id or decision/modification mismatch rejects
 * identically. `extraKeys` names door-specific envelope keys the caller
 * validates itself.
 */
export function parseOperatorConfirmationParams(
  body: unknown,
  extraKeys: readonly string[] = [],
): ConfirmationResolveRequest | undefined {
  if (!isRecord(body)
    || Object.keys(body).some(key => (
      !(DECISION_KEYS as readonly string[]).includes(key) && !extraKeys.includes(key)
    ))
    || typeof body.id !== 'string'
    || !CONFIRMATION_ID_PATTERN.test(body.id)
    || (body.decision !== 'approve' && body.decision !== 'deny' && body.decision !== 'modify')
    || (body.decision === 'modify' && !isRecord(body.modifiedParams))
    || (body.decision !== 'modify' && body.modifiedParams !== undefined)) {
    return undefined;
  }
  return {
    id: body.id,
    decision: body.decision,
    ...(body.decision === 'modify'
      ? { modifiedParams: body.modifiedParams as Record<string, unknown> }
      : {}),
  };
}
