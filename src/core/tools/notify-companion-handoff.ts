import { createHash } from 'node:crypto';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import type {
  IcpAutonomyCandidateOrigin,
  PostTurnActionCandidate,
} from '../../shared/contracts/runtime.js';
import type { IcpDyadSideAction } from '../../shared/contracts/icp-autonomy.js';
import { MAX_ICP_PERMIT_TTL_MS } from '../../shared/contracts/icp-autonomy.js';
import type { PostTurnInferenceContext } from '../agent/substrate-agent/post-turn-actions.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid, toRecordView } from '../../shared/utils/types.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import {
  parseIcpAutonomyCandidateOrigin,
  resolveIcpAutonomyCandidateSchedulerOrigin,
} from '../icp/candidate-scheduler-origin.js';
import { textResult, textResultWithError } from './results.js';
import { assessDisclosure } from '../cogsec/disclosure/decision.js';
import type { DisclosureLineage } from '../cogsec/disclosure/contracts.js';
import {
  createHumanRelayIntentCapsule,
  type HumanRelayIntentCapsule,
} from '../icp/human-relay-capsule.js';

export const COMPANION_NOTIFY_TARGET_KIND = 'companion' as const;
export const COMPANION_PRIVATE_INTENT_MAX_LENGTH = 1_000;
export const COMPANION_NOTIFY_QUEUED_TEXT = 'notify: companion outreach queued for the target-channel turn.';
export const DEFERRED_COMPANION_OUTREACH_ACTION_KIND = 'notify.companion_outreach' as const;

export type CompanionNotifyParams =
  | {
      mode: 'initiation';
      action: 'send';
      target_kind: 'companion';
      contact_id: string;
      initiation_permit: string;
    }
  | {
      mode: 'continuation';
      action: 'send';
      target_kind: 'companion';
      dyad_id: string;
      private_intent: string;
    }
  | {
      mode: 'human_relay';
      action: 'relay';
      target_kind: 'companion';
      dyad_id: string;
      intent: string;
    }
  | {
      mode: 'list';
      action: 'list_dyads';
      target_kind: 'companion';
    }
  | {
      mode: 'lifecycle';
      action: 'dyad_lifecycle';
      target_kind: 'companion';
      dyad_id: string;
      expected_revision: number;
      lifecycle_action: IcpDyadSideAction;
    };

export type CompanionNotifyCatalogSource = 'extended';

export interface DeferredCompanionOutreachAuthorizationEvidence {
  version: 2;
  toolName: 'notify';
  toolScope: 'extended';
  catalogSource: 'extended';
  requiredCapability: 'external.companion';
  originToolCallId: string;
  originTurnId: string;
}

export interface DeferredCompanionOutreachAuthorizationRuntime {
  hasExternalCompanionCapability(): boolean;
  isNotifyToolRegistered(): boolean;
}

type DeferredCompanionOutreachPayload = ({
  mode: 'initiation';
  contactId: string;
  permitId: string;
  candidateOrigin?: IcpAutonomyCandidateOrigin;
  authorization: DeferredCompanionOutreachAuthorizationEvidence;
} | {
  mode: 'continuation';
  dyadId: string;
  privateIntent: string;
  deliveryId: string;
  conversationId: string;
  sourceDyadId?: string;
  continuationTaskKind?: import('../../shared/contracts/runtime.js').IcpContinuationTaskKind;
  authorization: DeferredCompanionOutreachAuthorizationEvidence;
} | {
  mode: 'human_relay';
  dyadId: string;
  deliveryId: string;
  conversationId: string;
  capsule: HumanRelayIntentCapsule;
  authorization: DeferredCompanionOutreachAuthorizationEvidence;
});

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function parseDeferredCompanionOutreachAuthorizationEvidence(
  value: unknown,
): DeferredCompanionOutreachAuthorizationEvidence | null {
  if (!isRecord(value)) return null;
  try {
    assertNoUnknownKeys(value, [
      'version',
      'toolName',
      'toolScope',
      'catalogSource',
      'requiredCapability',
      'originToolCallId',
      'originTurnId',
    ], 'deferred companion outreach authorization');
  } catch {
    return null;
  }
  if (value.version !== 2
    || value.toolName !== 'notify'
    || value.toolScope !== 'extended'
    || value.catalogSource !== 'extended'
    || value.requiredCapability !== 'external.companion'
    || !isExactNonEmptyString(value.originToolCallId)
    || !isExactNonEmptyString(value.originTurnId)) {
    return null;
  }
  return {
    version: 2,
    toolName: 'notify',
    toolScope: 'extended',
    catalogSource: 'extended',
    requiredCapability: 'external.companion',
    originToolCallId: value.originToolCallId,
    originTurnId: value.originTurnId,
  };
}

function isCurrentDeferredExecutionPolicyAuthorized(
  runtime: DeferredCompanionOutreachAuthorizationRuntime,
): boolean {
  return runtime.hasExternalCompanionCapability()
    && runtime.isNotifyToolRegistered();
}

export function resolveCompanionOutreachOriginCatalogSource(
  runtime: DeferredCompanionOutreachAuthorizationRuntime,
): 'extended' | null {
  if (!isCurrentDeferredExecutionPolicyAuthorized(runtime)) return null;
  return 'extended';
}

export function isDeferredCompanionOutreachExecutionAuthorized(
  evidence: unknown,
  runtime: DeferredCompanionOutreachAuthorizationRuntime,
): boolean {
  // Exact persisted origin evidence proves the authorized catalog source;
  // current capability and registration remain live revocation
  // points and are rechecked again immediately before the W3 target command.
  return parseDeferredCompanionOutreachAuthorizationEvidence(evidence) !== null
    && isCurrentDeferredExecutionPolicyAuthorized(runtime);
}

function parseCompanionNotifyParams(value: unknown): CompanionNotifyParams {
  if (!isRecord(value)) throw new Error('companion notify params must be an object');
  if (value.action === 'list_dyads') {
    assertNoUnknownKeys(value, ['action', 'target_kind'], 'companion dyad list params');
    if (value.target_kind !== COMPANION_NOTIFY_TARGET_KIND) {
      throw new Error('companion dyad list requires target_kind=companion');
    }
    return { mode: 'list', action: 'list_dyads', target_kind: 'companion' };
  }
  if (value.action === 'dyad_lifecycle') {
    assertNoUnknownKeys(value, [
      'action', 'target_kind', 'dyad_id', 'expected_revision', 'lifecycle_action',
    ], 'companion dyad lifecycle params');
    if (value.target_kind !== COMPANION_NOTIFY_TARGET_KIND || !isRfc4122Uuid(value.dyad_id)) {
      throw new Error('companion dyad lifecycle requires an exact dyad_id');
    }
    if (!Number.isSafeInteger(value.expected_revision) || Number(value.expected_revision) < 1) {
      throw new Error('companion dyad lifecycle requires a positive expected_revision');
    }
    if (value.lifecycle_action !== 'pause' && value.lifecycle_action !== 'resume'
      && value.lifecycle_action !== 'close' && value.lifecycle_action !== 'block'
      && value.lifecycle_action !== 'unblock') {
      throw new Error('companion dyad lifecycle action is invalid');
    }
    return {
      mode: 'lifecycle',
      action: 'dyad_lifecycle',
      target_kind: 'companion',
      dyad_id: value.dyad_id,
      expected_revision: Number(value.expected_revision),
      lifecycle_action: value.lifecycle_action,
    };
  }
  if (value.action === 'relay') {
    assertNoUnknownKeys(value, ['action', 'target_kind', 'dyad_id', 'intent'], 'human relay params');
    if (value.target_kind !== COMPANION_NOTIFY_TARGET_KIND || !isRfc4122Uuid(value.dyad_id)) {
      throw new Error('human relay requires an exact open dyad_id');
    }
    if (typeof value.intent !== 'string' || !value.intent.trim()
      || value.intent.length > COMPANION_PRIVATE_INTENT_MAX_LENGTH) {
      throw new Error('human relay intent must contain 1-1000 exact stated characters');
    }
    return {
      mode: 'human_relay',
      action: 'relay',
      target_kind: 'companion',
      dyad_id: value.dyad_id,
      intent: value.intent,
    };
  }
  if (value.action === 'send' && value.dyad_id !== undefined) {
    assertNoUnknownKeys(
      value,
      ['action', 'target_kind', 'dyad_id', 'private_intent'],
      'companion continuation params',
    );
    if (value.target_kind !== COMPANION_NOTIFY_TARGET_KIND || !isRfc4122Uuid(value.dyad_id)) {
      throw new Error('companion continuation requires an exact dyad_id');
    }
    if (typeof value.private_intent !== 'string' || !value.private_intent.trim()
      || value.private_intent.trim() !== value.private_intent || value.private_intent.length > 1_000) {
      throw new Error('private_intent must be an exact 1-1000 character private instruction');
    }
    return {
      mode: 'continuation',
      action: 'send',
      target_kind: 'companion',
      dyad_id: value.dyad_id,
      private_intent: value.private_intent,
    };
  }
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
    mode: 'initiation',
    action: 'send',
    target_kind: 'companion',
    contact_id: value.contact_id,
    initiation_permit: value.initiation_permit,
  };
}

function parseDeferredPayload(value: unknown): DeferredCompanionOutreachPayload | null {
  if (!isRecord(value)) return null;
  try {
    assertNoUnknownKeys(
      value,
      [
        'mode', 'contactId', 'permitId', 'candidateOrigin', 'dyadId', 'privateIntent',
        'deliveryId', 'conversationId', 'sourceDyadId', 'continuationTaskKind', 'authorization',
        'capsule',
      ],
      'deferred companion outreach payload',
    );
  } catch {
    return null;
  }
  const contactId = value.contactId;
  const permitId = value.permitId;
  let candidateOrigin: IcpAutonomyCandidateOrigin | undefined;
  try {
    candidateOrigin = value.candidateOrigin === undefined
      ? undefined
      : parseIcpAutonomyCandidateOrigin(value.candidateOrigin);
  } catch {
    return null;
  }
  const authorization = parseDeferredCompanionOutreachAuthorizationEvidence(value.authorization);
  if (!authorization) return null;
  if (value.mode === 'initiation' || value.mode === undefined) {
    if (typeof contactId !== 'string' || !contactId || contactId.trim() !== contactId) return null;
    if (!isRfc4122Uuid(permitId)) return null;
    return {
      mode: 'initiation', contactId, permitId,
      ...(candidateOrigin ? { candidateOrigin } : {}), authorization,
    };
  }
  if (value.mode === 'human_relay') {
    if (!isRfc4122Uuid(value.dyadId) || !isRfc4122Uuid(value.deliveryId)
      || !isRfc4122Uuid(value.conversationId) || !isRecord(value.capsule)) return null;
    return {
      mode: 'human_relay',
      dyadId: value.dyadId,
      deliveryId: value.deliveryId,
      conversationId: value.conversationId,
      capsule: value.capsule as unknown as HumanRelayIntentCapsule,
      authorization,
    };
  }
  if (value.mode !== 'continuation' || !isRfc4122Uuid(value.dyadId)
    || !isRfc4122Uuid(value.deliveryId) || !isRfc4122Uuid(value.conversationId)
    || typeof value.privateIntent !== 'string' || !value.privateIntent.trim()
    || value.privateIntent.trim() !== value.privateIntent
    || value.privateIntent.length > COMPANION_PRIVATE_INTENT_MAX_LENGTH
    || (value.sourceDyadId !== undefined && !isRfc4122Uuid(value.sourceDyadId))) return null;
  const continuationTaskKind = value.continuationTaskKind;
  if (continuationTaskKind !== undefined
    && continuationTaskKind !== 'work' && continuationTaskKind !== 'research'
    && continuationTaskKind !== 'problem_solving') return null;
  return {
    mode: 'continuation',
    dyadId: value.dyadId,
    privateIntent: value.privateIntent,
    deliveryId: value.deliveryId,
    conversationId: value.conversationId,
    ...(value.sourceDyadId ? { sourceDyadId: value.sourceDyadId } : {}),
    ...(continuationTaskKind ? { continuationTaskKind } : {}),
    authorization,
  };
}

export async function executeCompanionNotify(input: {
  runtime: AgentFacingIcpAutonomyRuntime;
  params: unknown;
  sourceDisclosureLineage?: DisclosureLineage;
}) {
  try {
    const requestContext = getRequestContext();
    if (!requestContext) {
      throw new Error('companion outreach requires an attributable turn context');
    }
    const params = parseCompanionNotifyParams(input.params);
    if (params.mode === 'list') {
      const dyads = await input.runtime.listDyads();
      return textResult(JSON.stringify({ dyads }));
    }
    if (params.mode === 'lifecycle') {
      const result = await input.runtime.transitionDyad({
        dyadId: params.dyad_id,
        expectedRevision: params.expected_revision,
        action: params.lifecycle_action,
      });
      return textResult(JSON.stringify(result));
    }
    if (params.mode === 'human_relay') {
      if (requestContext.requesterProvenance !== 'human'
        || !requestContext.viewerAuthorId
        || !requestContext.viewerMemorySubjectContactId
        || requestContext.icpCorrelation) {
        throw new Error('human relay requires an attributable human source turn outside ICP');
      }
      const dyad = await input.runtime.inspectOpenDyad(params.dyad_id);
      const disclosure = assessDisclosure(input.sourceDisclosureLineage, {
        kind: 'contact_dm',
        contactId: dyad.peerContactId,
      });
      if (!disclosure.allowed) {
        throw new Error(`human relay source disclosure denied: ${disclosure.reason}`);
      }
      return textResult(COMPANION_NOTIFY_QUEUED_TEXT);
    }
    if (params.mode === 'continuation') {
      const dyad = await input.runtime.inspectOpenDyad(params.dyad_id);
      if (requestContext.icpCorrelation
        && requestContext.icpCorrelation.channelId !== dyad.channelId) {
        throw new Error('an ICP turn may continue only its own dyad');
      }
      return textResult(COMPANION_NOTIFY_QUEUED_TEXT);
    }
    if (requestContext.icpCorrelation) {
      throw new Error('first-contact outreach is blocked during an ICP-correlated turn');
    }
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

function deriveContinuationUuid(kind: string, turnId: string, toolCallId: string): string {
  const hex = createHash('sha256').update(`${kind}\0${turnId}\0${toolCallId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type ToolResultAgentMessage = Extract<AgentMessage, { role: 'toolResult' }>;

function isSuccessfulCompanionNotifyResult(message: AgentMessage): message is ToolResultAgentMessage {
  if (message.role !== 'toolResult' || message.isError === true || message.toolName !== 'notify') {
    return false;
  }
  return message.content.some(content => (
    content.type === 'text' && content.text === COMPANION_NOTIFY_QUEUED_TEXT
  ));
}

export function inferDeferredCompanionOutreachActions(
  context: PostTurnInferenceContext,
  originCatalogSource: CompanionNotifyCatalogSource | null = null,
): PostTurnActionCandidate[] {
  if (!originCatalogSource) return [];
  const candidateOrigin = resolveIcpAutonomyCandidateSchedulerOrigin(context.message);
  if (candidateOrigin && candidateOrigin.continuationTaskKind !== context.taskKind) {
    throw new Error('ICP candidate scheduler task kind lost its typed origin binding');
  }
  const requestedByToolCallId = new Map<string, DeferredCompanionOutreachPayload>();
  for (const message of context.turnMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (content.type !== 'toolCall' || typeof content.id !== 'string' || content.name !== 'notify') {
        continue;
      }
      try {
        const params = parseCompanionNotifyParams(content.arguments);
        if (params.mode === 'list' || params.mode === 'lifecycle' || params.mode === 'human_relay') continue;
        const authorization = {
            version: 2,
            toolName: 'notify',
            toolScope: 'extended',
            catalogSource: originCatalogSource,
            requiredCapability: 'external.companion',
            originToolCallId: content.id,
            originTurnId: context.turnId,
        } as const;
        requestedByToolCallId.set(content.id, params.mode === 'initiation'
          ? {
              mode: 'initiation', contactId: params.contact_id,
              permitId: params.initiation_permit,
              ...(candidateOrigin ? { candidateOrigin } : {}), authorization,
            }
          : {
              mode: 'continuation', dyadId: params.dyad_id,
              privateIntent: params.private_intent,
              deliveryId: deriveContinuationUuid('delivery', context.turnId, content.id),
              conversationId: deriveContinuationUuid('conversation', context.turnId, content.id),
              ...(context.message.routing?.icpCorrelation
                ? { sourceDyadId: params.dyad_id }
                : {}),
              ...(candidateOrigin?.continuationTaskKind
                ? { continuationTaskKind: candidateOrigin.continuationTaskKind }
                : {}),
              authorization,
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
    const permitFingerprint = createHash('sha256')
      .update(payload.mode === 'initiation' ? payload.permitId : payload.deliveryId)
      .digest('hex').slice(0, 20);
    actions.push({
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: toRecordView(payload),
      dedupeKey: `${DEFERRED_COMPANION_OUTREACH_ACTION_KIND}:${permitFingerprint}`,
      maxRetries: 2,
    });
  }
  return actions;
}

export async function inferDeferredHumanRelayActions(input: {
  context: PostTurnInferenceContext;
  runtime: AgentFacingIcpAutonomyRuntime;
  localCompanionId: string;
  originCatalogSource: CompanionNotifyCatalogSource | null;
}): Promise<PostTurnActionCandidate[]> {
  if (!input.originCatalogSource) return [];
  const { context } = input;
  if (!context.canonicalContactKey || !context.message.authorId
    || context.message.channelType === 'companion'
    || context.message.channelId.startsWith('internal:')) return [];

  const requests = new Map<string, Extract<CompanionNotifyParams, { mode: 'human_relay' }>>();
  for (const message of context.turnMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (content.type !== 'toolCall' || content.name !== 'notify' || typeof content.id !== 'string') continue;
      try {
        const parsed = parseCompanionNotifyParams(content.arguments);
        if (parsed.mode === 'human_relay') requests.set(content.id, parsed);
      } catch {
        // Invalid calls cannot have produced an authorized success marker.
      }
    }
  }

  const actions: PostTurnActionCandidate[] = [];
  for (const message of context.turnMessages) {
    if (!isSuccessfulCompanionNotifyResult(message) || !message.toolCallId) continue;
    const request = requests.get(message.toolCallId);
    if (!request) continue;
    const dyad = await input.runtime.inspectOpenDyad(request.dyad_id);
    const disclosure = assessDisclosure(context.disclosureLineage, {
      kind: 'contact_dm',
      contactId: dyad.peerContactId,
    });
    if (!disclosure.allowed || !context.disclosureLineage) continue;
    const capsuleId = deriveContinuationUuid('human-relay-capsule', context.turnId, message.toolCallId);
    const deliveryId = deriveContinuationUuid('human-relay-delivery', context.turnId, message.toolCallId);
    const conversationId = deriveContinuationUuid('human-relay-conversation', context.turnId, message.toolCallId);
    const provenanceRefs = [...new Set([
      context.disclosureLineage.generationContextRef,
      ...context.disclosureLineage.provenanceRefs,
    ])];
    const capsule = await createHumanRelayIntentCapsule({
      capsuleId,
      intent: request.intent,
      sourceMessage: context.message.content,
      source: {
        companionId: input.localCompanionId,
        channelId: context.message.channelId,
        turnId: context.turnId,
        requestId: context.response.metadata.requestId ?? context.message.id,
        messageId: context.message.id,
        humanParticipantId: context.message.authorId,
        humanContactId: context.canonicalContactKey,
        requesterKind: 'human',
      },
      target: {
        companionId: dyad.peerCompanionId,
        peerContactId: dyad.peerContactId,
        dyadId: dyad.dyadId,
        channelId: dyad.channelId,
        participantCompanionIds: [input.localCompanionId, dyad.peerCompanionId],
      },
      issuedAtMs: context.completedAt,
      expiresAtMs: context.completedAt + MAX_ICP_PERMIT_TTL_MS,
      sourceGate: binding => ({
        authorized: disclosure.allowed,
        boundary: 'source_egress',
        bindingHash: binding.bindingHash,
        policyRef: `cogsec:disclosure:${disclosure.outcome}`,
        provenanceRefs,
        disclosureCeiling: 'stated_intent_only',
        decidedAtMs: context.completedAt,
      }),
    });
    const authorization = {
      version: 2,
      toolName: 'notify',
      toolScope: 'extended',
      catalogSource: input.originCatalogSource,
      requiredCapability: 'external.companion',
      originToolCallId: message.toolCallId,
      originTurnId: context.turnId,
    } as const;
    actions.push({
      kind: DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
      payload: toRecordView({
        mode: 'human_relay',
        dyadId: dyad.dyadId,
        deliveryId,
        conversationId,
        capsule,
        authorization,
      }),
      dedupeKey: `${DEFERRED_COMPANION_OUTREACH_ACTION_KIND}:${capsuleId}`,
      maxRetries: 0,
    });
  }
  return actions;
}

export function registerDeferredCompanionOutreachRuntime(input: {
  agentLoop: {
    registerPostTurnActionInferer?(
      inferer: (context: PostTurnInferenceContext) => PostTurnActionCandidate[] | Promise<PostTurnActionCandidate[]>,
    ): () => void;
  };
  postTurnActions: PostTurnActionRuntime;
  runtime: AgentFacingIcpAutonomyRuntime;
  localCompanionId: string;
  resolveOriginCatalogSource(): CompanionNotifyCatalogSource | null;
  isExecutionAuthorized(evidence: DeferredCompanionOutreachAuthorizationEvidence): boolean;
}): () => void {
  const unregisterInferer = input.agentLoop.registerPostTurnActionInferer?.(async (context) => [
    ...inferDeferredCompanionOutreachActions(context, input.resolveOriginCatalogSource()),
    ...await inferDeferredHumanRelayActions({
      context,
      runtime: input.runtime,
      localCompanionId: input.localCompanionId,
      originCatalogSource: input.resolveOriginCatalogSource(),
    }),
  ]) ?? (() => undefined);
  const unregisterHandler = input.postTurnActions.registerHandler(
    DEFERRED_COMPANION_OUTREACH_ACTION_KIND,
    async (action) => {
      const payload = parseDeferredPayload(action.payload);
      if (!payload) throw new Error('Deferred companion outreach payload is malformed');
      const revalidate = () => input.isExecutionAuthorized(payload.authorization);
      if (!revalidate()) {
        throw new Error('Deferred companion outreach is no longer capability/tool-policy authorized');
      }
      if (payload.mode === 'initiation') {
        await input.runtime.executeCompanionOutreach(
          payload.contactId, payload.permitId, payload.candidateOrigin, revalidate,
        );
      } else if (payload.mode === 'continuation') {
        await input.runtime.executeDyadContinuation({
          dyadId: payload.dyadId,
          deliveryId: payload.deliveryId,
          conversationId: payload.conversationId,
          privateIntent: payload.privateIntent,
          initiationSource: 'foreground',
          ...(payload.sourceDyadId ? { sourceDyadId: payload.sourceDyadId } : {}),
          ...(payload.continuationTaskKind
            ? { continuationTaskKind: payload.continuationTaskKind }
            : {}),
        }, revalidate);
      } else {
        await input.runtime.executeHumanRelay({
          dyadId: payload.dyadId,
          deliveryId: payload.deliveryId,
          conversationId: payload.conversationId,
          capsule: payload.capsule,
        }, revalidate);
      }
    },
    { executionMode: 'background' },
  );
  return () => {
    unregisterHandler();
    unregisterInferer();
  };
}
