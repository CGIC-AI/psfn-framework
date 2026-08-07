import {
  type PostTurnSubagentSpawnQueuedStatus,
} from './post-turn-action-runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { toPositiveInteger } from '../../shared/utils/numeric.js';

export function resolvePostTurnSubagentSpawnQueuedStatus(
  payload: Record<string, unknown>,
): PostTurnSubagentSpawnQueuedStatus | undefined {
  if (!isRecord(payload.policy)) {
    return undefined;
  }
  const request = isRecord(payload.request) ? payload.request : {};
  const budget = isRecord(payload.policy.budget) ? payload.policy.budget : {};
  const requestName = typeof request.name === 'string' && request.name.trim()
    ? request.name.trim()
    : undefined;
  const policyMode = typeof payload.policy.mode === 'string' && payload.policy.mode.trim()
    ? payload.policy.mode.trim()
    : undefined;
  const budgetMaxTurns = toPositiveInteger(budget.maxTurns);
  const requestedMaxTurns = toPositiveInteger(request.maxTurns);
  return {
    ...(requestName ? { requestName } : {}),
    ...(policyMode ? { policyMode } : {}),
    policyAllowed: payload.policy.allow === true,
    ...(budgetMaxTurns !== undefined ? { budgetMaxTurns } : {}),
    ...(requestedMaxTurns !== undefined ? { requestedMaxTurns } : {}),
  };
}
