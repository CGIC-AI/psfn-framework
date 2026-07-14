import type { LLMCallAccountingContext } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

const MAX_LOGICAL_CALL_ID_LENGTH = 512;

export function normalizeLLMCallAccountingContext(
  value: unknown,
): LLMCallAccountingContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('accounting must be an object');
  }
  const logicalCallId = typeof value.logicalCallId === 'string'
    ? value.logicalCallId.trim()
    : '';
  if (!logicalCallId || logicalCallId.length > MAX_LOGICAL_CALL_ID_LENGTH) {
    throw new Error(
      `accounting.logicalCallId must be a non-empty string of at most ${MAX_LOGICAL_CALL_ID_LENGTH} characters`,
    );
  }
  const attempt = value.attempt;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('accounting.attempt must be a positive safe integer');
  }
  const retryOwner = value.retryOwner;
  if (retryOwner !== undefined && retryOwner !== 'caller') {
    throw new Error("accounting.retryOwner must be 'caller' when provided");
  }
  return {
    logicalCallId,
    attempt,
    ...(retryOwner === 'caller' ? { retryOwner } : {}),
  };
}
