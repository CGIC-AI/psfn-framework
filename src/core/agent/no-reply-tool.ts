import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import type { IntentionalNoReplyMetadata } from '../../shared/contracts/runtime.js';
import {
  NO_REPLY_DISPOSITION,
  RESPONSE_CONTROL_TOOL_NAME,
} from '../../shared/agent-response-disposition.js';
import {
  listPendingPaidDeliverables,
  type PendingPaidDeliverable,
} from '../../shared/paid-deliverable-tracking.js';

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

function describePendingPaidDeliverables(pending: readonly PendingPaidDeliverable[]): string {
  return pending
    .map((entry) => {
      const label = entry.identifier ?? entry.toolCallId ?? entry.surface;
      const count = entry.artifactCount && entry.artifactCount > 1 ? ` x${entry.artifactCount}` : '';
      const via = entry.toolName ? ` via ${entry.toolName}` : '';
      return `${label}${count}${via}`;
    })
    .join(', ');
}

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
      params: unknown,
    ): Promise<AgentToolResult<{ isError?: boolean; noReply?: boolean; auditId?: string }>> => {
      // Fail closed on malformed calls: recording an intentional no-reply from
      // empty/garbled arguments would silently swallow the turn's outward
      // response. A dropped-args tool call (see bead psfn-framework-gu8m) must
      // never be able to silence the companion.
      if (!isResponseControlParams(params)) {
        return responseControlResult({
          ok: false,
          error: 'response_control requires action="no_reply"; refusing to record a no-reply decision from empty or malformed arguments.',
        }, true);
      }

      // Fail closed: a paid deliverable produced this turn (at minimum a charged
      // image generation) has not reached the user yet. Honoring no-reply here
      // would silently drop an artifact they already paid for. Reject the request
      // and require an explicit reply so the pending attachment rides out with it.
      const pendingPaidDeliverables = listPendingPaidDeliverables();
      if (pendingPaidDeliverables.length > 0) {
        return responseControlResult({
          ok: false,
          error:
            'A paid attachment generated this turn is still pending delivery and has not been sent to the user. '
            + 'Intentional no-reply is rejected so the paid artifact is not silently dropped. '
            + 'Send a reply this turn (even one short line) so the pending attachment is delivered with it. '
            + `Pending paid deliverables: ${describePendingPaidDeliverables(pendingPaidDeliverables)}.`,
        }, true);
      }

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

function isResponseControlParams(value: unknown): value is ResponseControlParams {
  return typeof value === 'object'
    && value !== null
    && 'action' in value
    && value.action === 'no_reply';
}
