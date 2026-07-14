import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import type { PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import type { PostTurnInferenceContext } from '../agent/substrate-agent/post-turn-actions.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type {
  IcpInitiationSourceRequest,
  IcpInitiationSourceRuntime,
} from '../icp/initiation-source-runtime.js';
import { textResult, textResultWithError } from './results.js';
import {
  parseDeferredCompanionOutreachAuthorizationEvidence,
  type CompanionNotifyOverlayActivationSource,
  type DeferredCompanionOutreachAuthorizationEvidence,
} from './notify-companion-handoff.js';

export const COMPANION_CANDIDATE_QUEUED_TEXT = 'notify: private companion initiation candidate queued.';
export const ICP_INITIATION_CANDIDATE_ACTION_KIND = 'notify.companion_candidate' as const;

export interface CompanionCandidateParams {
  action: 'consider';
  target_kind: 'companion';
  contact_id: string;
  reason_summary: string;
}

interface CandidateActionPayload {
  request: IcpInitiationSourceRequest;
  authorization: DeferredCompanionOutreachAuthorizationEvidence;
}

function exactString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${field} must be an exact non-empty string`);
  }
  if (value.length > maxChars) throw new Error(`${field} is too long`);
  return value;
}

export function parseCompanionCandidateParams(value: unknown): CompanionCandidateParams {
  if (!isRecord(value)) throw new Error('companion candidate params must be an object');
  assertNoUnknownKeys(
    value,
    ['action', 'target_kind', 'contact_id', 'reason_summary'],
    'companion candidate params',
  );
  if (value.action !== 'consider' || value.target_kind !== 'companion') {
    throw new Error('companion candidate requires action=consider and target_kind=companion');
  }
  return {
    action: 'consider',
    target_kind: 'companion',
    contact_id: exactString(value.contact_id, 'contact_id', 512),
    reason_summary: exactString(value.reason_summary, 'reason_summary', 1_000),
  };
}

export function executeCompanionCandidateConsider(value: unknown, enabled: boolean) {
  try {
    if (!enabled) throw new Error('companion candidate runtime is not wired');
    parseCompanionCandidateParams(value);
    return textResult(COMPANION_CANDIDATE_QUEUED_TEXT);
  } catch (error) {
    return textResultWithError(
      `notify: companion candidate blocked (${error instanceof Error ? error.message : String(error)}).`,
      true,
    );
  }
}

function isSuccessfulCandidateResult(message: AgentMessage): boolean {
  return message.role === 'toolResult'
    && message.isError !== true
    && message.toolName === 'notify'
    && message.content.some(part => (
      part.type === 'text' && part.text === COMPANION_CANDIDATE_QUEUED_TEXT
    ));
}

function parseSourceRequest(value: unknown): IcpInitiationSourceRequest | null {
  if (!isRecord(value)) return null;
  try {
    assertNoUnknownKeys(value, [
      'source', 'peerContactId', 'preferredChannel', 'sourceRecordId',
      'reasonSummary', 'cause',
    ], 'ICP candidate source request');
  } catch {
    return null;
  }
  if (value.source !== 'free_time' && value.source !== 'foreground') return null;
  if (value.preferredChannel !== 'dm') return null;
  if (!isRecord(value.cause)) return null;
  let cause: IcpInitiationSourceRequest['cause'];
  try {
    if (value.cause.kind === 'independent') {
      assertNoUnknownKeys(value.cause, ['kind'], 'ICP independent candidate cause');
      cause = { kind: 'independent' };
    } else if (value.cause.kind === 'icp_conversation') {
      assertNoUnknownKeys(value.cause, ['kind', 'rootInitiationId'], 'ICP inherited candidate cause');
      if (!isRfc4122Uuid(value.cause.rootInitiationId)) return null;
      cause = { kind: 'icp_conversation', rootInitiationId: value.cause.rootInitiationId };
    } else {
      return null;
    }
    return {
      source: value.source,
      peerContactId: exactString(value.peerContactId, 'peerContactId', 512),
      preferredChannel: 'dm',
      sourceRecordId: exactString(value.sourceRecordId, 'sourceRecordId', 1_024),
      reasonSummary: exactString(value.reasonSummary, 'reasonSummary', 1_000),
      cause,
    };
  } catch {
    return null;
  }
}

function parseActionPayload(value: unknown): CandidateActionPayload | null {
  if (!isRecord(value)) return null;
  try {
    assertNoUnknownKeys(value, ['request', 'authorization'], 'ICP candidate action payload');
  } catch {
    return null;
  }
  const request = parseSourceRequest(value.request);
  const authorization = parseDeferredCompanionOutreachAuthorizationEvidence(value.authorization);
  return request && authorization ? { request, authorization } : null;
}

export function inferIcpInitiationCandidateActions(
  context: PostTurnInferenceContext,
  originActivationSource: CompanionNotifyOverlayActivationSource | null = null,
): PostTurnActionCandidate[] {
  if (!originActivationSource) return [];
  const channelId = context.message.channelId;
  const source = channelId.startsWith('internal:free-time:')
    ? 'free_time' as const
    : channelId.startsWith('internal:')
      ? null
      : 'foreground' as const;
  if (!source) return [];

  const requested = new Map<string, CompanionCandidateParams>();
  for (const message of context.turnMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || part.name !== 'notify' || typeof part.id !== 'string') continue;
      try {
        requested.set(part.id, parseCompanionCandidateParams(part.arguments));
      } catch {
        // Invalid calls cannot pair with a successful exact marker.
      }
    }
  }

  const actions: PostTurnActionCandidate[] = [];
  for (const message of context.turnMessages) {
    if (!isSuccessfulCandidateResult(message) || !message.toolCallId) continue;
    const params = requested.get(message.toolCallId);
    if (!params) continue;
    const inheritedRoot = context.message.routing?.icpCorrelation?.rootInitiationId;
    const payload: CandidateActionPayload = {
      request: {
        source,
        peerContactId: params.contact_id,
        preferredChannel: 'dm',
        sourceRecordId: `${context.turnId}:${message.toolCallId}`,
        reasonSummary: params.reason_summary,
        cause: inheritedRoot
          ? { kind: 'icp_conversation', rootInitiationId: inheritedRoot }
          : { kind: 'independent' },
      },
      authorization: {
        version: 1,
        toolName: 'notify',
        toolScope: 'extended',
        activationSource: originActivationSource,
        requiredCapability: 'external.companion',
        originToolCallId: message.toolCallId,
        originTurnId: String(context.turnId),
      },
    };
    actions.push({
      kind: ICP_INITIATION_CANDIDATE_ACTION_KIND,
      payload,
      dedupeKey: `${ICP_INITIATION_CANDIDATE_ACTION_KIND}:${context.turnId}:${message.toolCallId}`,
      maxRetries: 2,
    });
  }
  return actions;
}

export function registerIcpInitiationCandidatePostTurnRuntime(input: {
  agentLoop: {
    registerPostTurnActionInferer(
      inferer: (context: PostTurnInferenceContext) => PostTurnActionCandidate[],
    ): () => void;
  };
  postTurnActions: PostTurnActionRuntime;
  runtime: IcpInitiationSourceRuntime;
  resolveOriginActivationSource(): CompanionNotifyOverlayActivationSource | null;
  isExecutionAuthorized(evidence: DeferredCompanionOutreachAuthorizationEvidence): boolean;
}): () => void {
  const unregisterInferer = input.agentLoop.registerPostTurnActionInferer((context) => (
    inferIcpInitiationCandidateActions(context, input.resolveOriginActivationSource())
  ));
  const unregisterHandler = input.postTurnActions.registerHandler(
    ICP_INITIATION_CANDIDATE_ACTION_KIND,
    async action => {
      const payload = parseActionPayload(action.payload);
      if (!payload) throw new Error('ICP initiation candidate action payload is malformed');
      if (!input.isExecutionAuthorized(payload.authorization)) {
        throw new Error('ICP initiation candidate is no longer capability/tool-policy authorized');
      }
      const outcome = await input.runtime.submit(payload.request);
      return { detail: `${outcome.outcome}:${outcome.status}` };
    },
  );
  return () => {
    unregisterHandler();
    unregisterInferer();
  };
}
