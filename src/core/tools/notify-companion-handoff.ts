import { createHash } from 'node:crypto';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import type {
  PostTurnActionCandidate,
} from '../../shared/contracts/runtime.js';
import type { PostTurnInferenceContext } from '../agent/substrate-agent/post-turn-actions.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import { textResult, textResultWithError } from './results.js';

export const COMPANION_NOTIFY_TARGET_KIND = 'companion' as const;
export const COMPANION_NOTIFY_QUEUED_TEXT = 'notify: companion outreach queued for the target-channel turn.';
export const DEFERRED_COMPANION_OUTREACH_ACTION_KIND = 'notify.companion_outreach' as const;

export interface CompanionNotifyParams {
  action: 'send';
  target_kind: 'companion';
  contact_id: string;
  initiation_permit: string;
}

interface DeferredCompanionOutreachPayload {
  contactId: string;
  permitId: string;
}

function parseCompanionNotifyParams(value: unknown): CompanionNotifyParams {
  if (!isRecord(value)) throw new Error('companion notify params must be an object');
  assertNoUnknownKeys(
    value,
    ['action', 'target_kind', 'contact_id', 'initiation_permit'],
    'companion notify params',
  );
  if (value.action !== 'send' || value.target_kind !== COMPANION_NOTIFY_TARGET_KIND) {
    throw new Error('companion notify requires action=send and target_kind=companion');
  }
  if (typeof value.contact_id !== 'string'
    || !value.contact_id
    || value.contact_id.trim() !== value.contact_id) {
    throw new Error('contact_id must be an exact non-empty canonical contact ID');
  }
  if (!isRfc4122Uuid(value.initiation_permit)) {
    throw new Error('initiation_permit must be a lowercase RFC-4122 UUID');
  }
  return {
    action: 'send',
    target_kind: 'companion',
    contact_id: value.contact_id,
    initiation_permit: value.initiation_permit,
  };
}

function parseDeferredPayload(value: unknown): DeferredCompanionOutreachPayload | null {
  if (!isRecord(value)) return null;
  const contactId = value.contactId;
  const permitId = value.permitId;
  if (typeof contactId !== 'string' || !contactId || contactId.trim() !== contactId) return null;
  if (!isRfc4122Uuid(permitId)) return null;
  return { contactId, permitId };
}

export async function executeCompanionNotify(input: {
  runtime: AgentFacingIcpAutonomyRuntime;
  params: unknown;
}) {
  try {
    const requestContext = getRequestContext();
    if (!requestContext) {
      throw new Error('companion outreach requires an attributable turn context');
    }
    if (requestContext.icpCorrelation) {
      throw new Error('companion outreach is blocked during an ICP-correlated turn');
    }
    const params = parseCompanionNotifyParams(input.params);
    await input.runtime.prepareCompanionOutreach(
      params.contact_id,
      params.initiation_permit,
    );
    return textResult(COMPANION_NOTIFY_QUEUED_TEXT);
  } catch (error) {
    return textResultWithError(
      `notify: companion outreach blocked (${error instanceof Error ? error.message : String(error)}).`,
      true,
    );
  }
}

function isSuccessfulCompanionNotifyResult(message: AgentMessage): boolean {
  if (message.role !== 'toolResult' || message.isError === true || message.toolName !== 'notify') {
    return false;
  }
  return message.content.some(content => (
    content.type === 'text' && content.text === COMPANION_NOTIFY_QUEUED_TEXT
  ));
}

export function inferDeferredCompanionOutreachActions(
  context: PostTurnInferenceContext,
): PostTurnActionCandidate[] {
  const requestedByToolCallId = new Map<string, DeferredCompanionOutreachPayload>();
  for (const message of context.turnMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (content.type !== 'toolCall' || typeof content.id !== 'string' || content.name !== 'notify') {
        continue;
      }
      try {
        const params = parseCompanionNotifyParams(content.arguments);
        requestedByToolCallId.set(content.id, {
          contactId: params.contact_id,
          permitId: params.initiation_permit,
        });
      } catch {
        // Invalid calls cannot produce a successful marker and are never queued.
      }
    }
  }

  const actions: PostTurnActionCandidate[] = [];
  for (const message of context.turnMessages) {
    if (!isSuccessfulCompanionNotifyResult(message) || !message.toolCallId) continue;
    const payload = requestedByToolCallId.get(message.toolCallId);
    if (!payload) continue;
    const permitFingerprint = createHash('sha256').update(payload.permitId).digest('hex').slice(0, 20);
    actions.push({
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload,
      dedupeKey: `${DEFERRED_COMPANION_OUTREACH_ACTION_KIND}:${permitFingerprint}`,
      maxRetries: 2,
    });
  }
  return actions;
}

export function registerDeferredCompanionOutreachRuntime(input: {
  agentLoop: {
    registerPostTurnActionInferer?(
      inferer: (context: PostTurnInferenceContext) => PostTurnActionCandidate[],
    ): () => void;
  };
  postTurnActions: PostTurnActionRuntime;
  runtime: AgentFacingIcpAutonomyRuntime;
  isExecutionAuthorized(): boolean;
}): () => void {
  const unregisterInferer = input.agentLoop.registerPostTurnActionInferer?.(
    inferDeferredCompanionOutreachActions,
  ) ?? (() => undefined);
  const unregisterHandler = input.postTurnActions.registerHandler(
    DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
    async (action) => {
      if (!input.isExecutionAuthorized()) {
        throw new Error('Deferred companion outreach is no longer capability/tool-overlay authorized');
      }
      const payload = parseDeferredPayload(action.payload);
      if (!payload) throw new Error('Deferred companion outreach payload is malformed');
      await input.runtime.executeCompanionOutreach(payload.contactId, payload.permitId);
    },
    { executionMode: 'background' },
  );
  return () => {
    unregisterHandler();
    unregisterInferer();
  };
}
