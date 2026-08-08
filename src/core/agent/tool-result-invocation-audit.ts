import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { redactSecretsInValue } from '../../shared/diagnostics/redaction.js';
import { isRecord } from '../../shared/utils/types.js';

export interface ToolResultInvocationAudit {
  arguments?: unknown;
  rationale?: string;
  thoughtSignature?: string;
}

const TOOL_RESULT_INVOCATION_AUDIT_KEY = 'psfnInvocationAudit';

export function redactSecretBearingToolArguments(
  argumentsValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined;
export function redactSecretBearingToolArguments(argumentsValue: unknown): unknown;
export function redactSecretBearingToolArguments(argumentsValue: unknown): unknown {
  return argumentsValue === undefined ? undefined : redactSecretsInValue(argumentsValue);
}

export function sanitizeToolResultInvocationAudit(
  audit: Record<string, unknown> | ToolResultInvocationAudit,
): ToolResultInvocationAudit {
  return {
    ...(Object.hasOwn(audit, 'arguments')
      ? { arguments: redactSecretBearingToolArguments(audit.arguments) }
      : {}),
    ...(typeof audit.rationale === 'string' && audit.rationale
      ? { rationale: audit.rationale }
      : {}),
    ...(typeof audit.thoughtSignature === 'string' && audit.thoughtSignature
      ? { thoughtSignature: audit.thoughtSignature }
      : {}),
  };
}

export function getToolResultInvocationAudit(
  message: ToolResultMessage,
): ToolResultInvocationAudit | undefined {
  const audit = (message as unknown as Record<string, unknown>)[TOOL_RESULT_INVOCATION_AUDIT_KEY];
  return isRecord(audit) ? sanitizeToolResultInvocationAudit(audit) : undefined;
}

export function attachToolResultInvocationAudit<T extends ToolResultMessage>(
  message: T,
  invocationAudit: ToolResultInvocationAudit,
): T {
  (message as unknown as Record<string, unknown>)[TOOL_RESULT_INVOCATION_AUDIT_KEY] =
    sanitizeToolResultInvocationAudit(invocationAudit);
  return message;
}

/**
 * Build the model-facing view of a tool result. Invocation audit metadata is
 * persistence-only: providers receive the ordinary tool result fields, never
 * the persisted arguments, rationale, or thought signature.
 */
export function stripToolResultInvocationAuditForModel(
  message: ToolResultMessage,
): ToolResultMessage {
  const {
    [TOOL_RESULT_INVOCATION_AUDIT_KEY]: _persistenceAudit,
    ...modelMessage
  } = message as unknown as Record<string, unknown>;
  return modelMessage as unknown as ToolResultMessage;
}
