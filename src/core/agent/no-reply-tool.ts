import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { IntentionalNoReplyMetadata } from '../../shared/contracts/runtime.js';
import {
  NO_REPLY_DISPOSITION,
  RESPONSE_CONTROL_TOOL_NAME,
} from '../../shared/agent-response-disposition.js';

const MAX_NO_REPLY_REASON_LENGTH = 500;

const RESPONSE_CONTROL_PARAMETERS = Type.Object({
  action: Type.Unsafe<'no_reply'>({
    type: 'string',
    const: 'no_reply',
    description: 'Set to no_reply to intentionally send no outward response for this turn.',
  }),
  reason: Type.Optional(Type.String({
    maxLength: MAX_NO_REPLY_REASON_LENGTH,
    description: 'Optional brief audit reason for intentional quiet.',
  })),
});

type ResponseControlParams = Static<typeof RESPONSE_CONTROL_PARAMETERS>;

export interface IntentionalNoReplyDecisionRequest {
  source: IntentionalNoReplyMetadata['source'];
  toolCallId?: string;
  reason?: string;
}

export type RecordIntentionalNoReplyDecision = (
  input: IntentionalNoReplyDecisionRequest,
) => IntentionalNoReplyMetadata | null;

function normalizeNoReplyReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_NO_REPLY_REASON_LENGTH);
}

function responseControlResult(
  payload: Record<string, unknown>,
  isError = false,
): AgentToolResult<{ isError?: boolean; noReply?: boolean; auditId?: string }> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    }] satisfies TextContent[],
    details: {
      ...(isError ? { isError: true } : {}),
      ...(payload.noReply === true ? { noReply: true } : {}),
      ...(typeof payload.auditId === 'string' ? { auditId: payload.auditId } : {}),
    },
  };
}

export function createResponseControlTool(
  recordDecision: RecordIntentionalNoReplyDecision,
): AgentTool<typeof RESPONSE_CONTROL_PARAMETERS, { isError?: boolean; noReply?: boolean; auditId?: string }> {
  return {
    name: RESPONSE_CONTROL_TOOL_NAME,
    label: RESPONSE_CONTROL_TOOL_NAME,
    description:
      'Control outward response disposition for the current turn. '
      + 'Use action=no_reply only when intentionally choosing silence/no outward reply; '
      + 'do not write NO_REPLY as text.',
    parameters: RESPONSE_CONTROL_PARAMETERS,
    execute: async (
      toolCallId: string,
      params: ResponseControlParams,
    ): Promise<AgentToolResult<{ isError?: boolean; noReply?: boolean; auditId?: string }>> => {
      const decision = recordDecision({
        source: 'response_control_tool',
        toolCallId,
        reason: normalizeNoReplyReason(params.reason),
      });
      if (!decision) {
        return responseControlResult({
          ok: false,
          error: 'No active turn correlation; no-reply sentinel was not accepted.',
        }, true);
      }

      return responseControlResult({
        ok: true,
        noReply: true,
        disposition: NO_REPLY_DISPOSITION,
        auditId: decision.auditId,
        reason: decision.reason ?? null,
        message: 'Intentional no-reply recorded. No outward response will be sent for this turn.',
      });
    },
  };
}
