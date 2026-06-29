import type {
  AgentResponse,
  IntentionalNoReplyMetadata,
} from './contracts/runtime.js';

export const NO_REPLY_DISPOSITION = 'intentional_no_reply' as const;
export const RESPONSE_CONTROL_TOOL_NAME = 'response_control' as const;

export type AgentResponseDisposition =
  | {
      kind: 'send';
      hasText: boolean;
      hasAttachments: boolean;
    }
  | {
      kind: 'intentional_no_reply';
      noReply: IntentionalNoReplyMetadata;
    }
  | {
      kind: 'policy_suppressed';
      reason: 'broadcast_approval_required' | 'fatigue_suppressed';
    }
  | {
      kind: 'empty_response_error';
    };

export function isIntentionalNoReplyResponse(
  response: Pick<AgentResponse, 'metadata'>,
): response is Pick<AgentResponse, 'metadata'> & {
  metadata: AgentResponse['metadata'] & { noReply: IntentionalNoReplyMetadata };
} {
  return response.metadata.noReply?.disposition === NO_REPLY_DISPOSITION;
}

export function resolveAgentResponseDisposition(
  response: AgentResponse,
): AgentResponseDisposition {
  if (isIntentionalNoReplyResponse(response)) {
    return {
      kind: 'intentional_no_reply',
      noReply: response.metadata.noReply,
    };
  }

  const hasText = response.content.trim().length > 0;
  const hasAttachments = (response.attachments ?? []).length > 0;
  if (hasText || hasAttachments) {
    return { kind: 'send', hasText, hasAttachments };
  }

  if (response.metadata.broadcastSafety?.approvalRequired) {
    return {
      kind: 'policy_suppressed',
      reason: 'broadcast_approval_required',
    };
  }

  if (response.metadata.fatigue?.modelDisposition === 'suppressed') {
    return {
      kind: 'policy_suppressed',
      reason: 'fatigue_suppressed',
    };
  }

  return { kind: 'empty_response_error' };
}
