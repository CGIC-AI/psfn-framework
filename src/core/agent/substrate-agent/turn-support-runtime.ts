import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { DisclosureLineage } from '../../cogsec/disclosure/contracts.js';
import {
  buildContextSourceManifest,
  contextSourceManifestContentDigest,
  type ContextSourceManifestBlockInput,
} from '../../cogsec/disclosure/context-source-manifest.js';
import {
  buildCustodySnapshot,
  custodySnapshotContentDigest,
  type CustodySnapshotStorePort,
} from '../../cogsec/disclosure/custody-snapshot.js';
import type { ToolResultCustodyEdge } from '../../../shared/contracts/tool-result-custody.js';
import { normalizeChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { AgentResponse, CorrelationMetadata, InferredPostTurnAction, IntentionalNoReplyMetadata, MessagePromptOverrideMode, ObservabilityCallType, ParentTurnContinuationStop, RuntimeFallbackProvenance, SubstrateMessage, TurnCustodySnapshotAbsenceReason, TurnCustodySnapshotOutcome, TurnID, TurnRecord, TurnUsage } from '../../../shared/contracts/runtime.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  resolveHealthEventOwner,
} from '../../../shared/contracts/health-event.js';
import type { TurnObservabilityRecord } from '../../turns/observability.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  AdaptiveToolDecisionTelemetry,
} from '../adaptive-tools-telemetry.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  buildTurnCorrelation as buildTurnCorrelationForTurn,
  buildTurnStageTelemetry as buildTurnStageTelemetryForTurn,
  resolveTurnCallType as resolveTurnCallTypeForTurn,
  withAdaptiveCorrelation as withAdaptiveCorrelationForTurn,
  withCorrelationPurpose as withCorrelationPurposeForTurn,
  type TurnStageName,
} from './turn-observability.js';
import {
  accumulateTurnUsage as accumulateTurnUsageForTurn,
  buildTurnRecord as buildTurnRecordForTurn,
  buildTurnToolSummary as buildTurnToolSummaryForTurn,
  recordAssistantMessage as recordAssistantMessageForTurn,
  recordToolObservations as recordToolObservationsForTurn,
  recordUserMessage as recordUserMessageForTurn,
  type TurnSessionWriteManager,
} from './turn-records.js';
import type { TurnToolResultCustodyRecord } from './turn-tool-result-custody.js';
import {
  inferPostTurnActions as inferPostTurnActionsForTurn,
  runIntentionPostTurnHooks as runIntentionPostTurnHooksForTurn,
  type IntentionPostTurnHook,
  type IntentionPostTurnHookContext,
  type IntentionPostTurnHookRunOptions,
  type PostTurnActionInferer,
  type PostTurnInferenceContext,
} from './post-turn-actions.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { SessionActorKind } from '../../session/turn-provenance.js';
import type { IntrospectionTurnSensitivityDecisions } from '../../../faculties/introspection/turn-sensitivity.js';
import { getRunChargeSnapshot } from '../../../shared/telemetry/run-charge.js';
import type {
  BackgroundWorkSupervisor,
  ForegroundWorkLease,
} from '../background-work/supervisor.js';
import type { EnqueueBackgroundWorkInput } from '../background-work/types.js';
import { DISABLED_BACKGROUND_WORK_MAX_ATTEMPTS } from '../background-work/config.js';
import type { TurnSessionIdentity } from './turn-execution/contracts.js';

const log = createComponentLogger('SubstrateAgent');

function resolveSessionChannelMeta(message: SubstrateMessage): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelPrivacy(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

export interface TurnSupportRuntimeOptions {
  eventBus: EventBus;
  sessionManager: TurnSessionWriteManager;
  backgroundWorkSupervisor: BackgroundWorkSupervisor | null;
  backgroundWorkMaxAttempts?: number;
  backgroundWorkDisabled?: boolean;
  hashPromptText: (text: string) => string;
  resolveContextWindow: () => number;
  /** Configured companion identity, used as the fallback companion scope on
   *  ordinary human-ingress turn correlations (icpCorrelation still wins). */
  companionId?: string;
  /**
   * Durable per-turn custody snapshot sink (psfn-framework-ccgdz.1). Absent,
   * the folded disclosure lineage stays in-process exactly as before.
   */
  custodySnapshotStore?: CustodySnapshotStorePort;
}

export class TurnSupportRuntime {
  private readonly eventBus: EventBus;
  private readonly sessionManager: TurnSessionWriteManager;
  private readonly backgroundWorkSupervisor: BackgroundWorkSupervisor | null;
  private readonly backgroundWorkDisabled: boolean;
  readonly backgroundWorkMaxAttempts: number;
  private readonly hashPromptText: (text: string) => string;
  private readonly resolveContextWindow: () => number;
  private readonly companionId?: string;
  private readonly custodySnapshotStore: CustodySnapshotStorePort | null;
  private introspectionTurnSensitivityDecisions: IntrospectionTurnSensitivityDecisions | null = null;

  private activeTurnCorrelation: CorrelationMetadata | null = null;
  private activeTurnTaskKind: string | null = null;
  private activeTurnIntent: string | null = null;
  private activeTurnSessionIdentity: TurnSessionIdentity | null = null;

  private readonly postTurnActionInferers: PostTurnActionInferer[] = [];
  private readonly intentionPostTurnHooks: IntentionPostTurnHook[] = [];
  private readonly intentionalNoReplyDecisions = new Map<TurnID, IntentionalNoReplyMetadata>();
  constructor(options: TurnSupportRuntimeOptions) {
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager;
    this.backgroundWorkSupervisor = options.backgroundWorkSupervisor;
    this.backgroundWorkDisabled = options.backgroundWorkDisabled === true;
    if (this.backgroundWorkDisabled && this.backgroundWorkSupervisor) {
      throw new Error('Background work cannot be both durable and disabled');
    }
    if (this.backgroundWorkSupervisor
      && (!Number.isSafeInteger(options.backgroundWorkMaxAttempts)
        || (options.backgroundWorkMaxAttempts ?? 0) <= 0)) {
      throw new Error('Durable background work requires scheduler-owned maxAttempts');
    }
    this.backgroundWorkMaxAttempts = options.backgroundWorkMaxAttempts
      ?? DISABLED_BACKGROUND_WORK_MAX_ATTEMPTS;
    this.hashPromptText = options.hashPromptText;
    this.resolveContextWindow = options.resolveContextWindow;
    this.companionId = typeof options.companionId === 'string' && options.companionId.trim().length > 0
      ? options.companionId.trim()
      : undefined;
    this.custodySnapshotStore = options.custodySnapshotStore ?? null;
  }

  /**
   * Project one lost custody snapshot into the health plane.
   *
   * A log line is not an incident. The turn deliberately does not fail on a
   * custody write, so without this a store that is down loses every turn's
   * durable proof and nothing ever escalates. The event is content-free — the
   * only subject is a digest of the FAILURE MODE, never the turn — so repeated
   * failures accumulate into one episode that the repeated-failure detector
   * opens as a single incident rather than one per turn.
   *
   * Fire-and-forget with a logged catch, like every other health emitter in an
   * error path: a telemetry fault must never mask the fault being reported, and
   * it must never fail the turn either.
   */
  private emitCustodySnapshotHealthEvent(
    mode: TurnCustodySnapshotAbsenceReason,
  ): void {
    void emitHealthEvent(this.eventBus, {
      owner: resolveHealthEventOwner(this.companionId),
      severity: 'degraded',
      code: 'custody_snapshot_write_failed',
      provenance: {
        process: 'agent',
        component: 'persistence',
        observerId: processObserverId(),
        subjectHash: hashHealthEventSubject(`custody_snapshot:${mode}`),
      },
      observedAtMs: Date.now(),
    }).catch((error: unknown) => {
      log.error('Custody snapshot health event emission failed', {
        error: toErrorMessage(error),
      });
    });
  }

  /**
   * Persist this turn's folded disclosure lineage as a durable custody snapshot
   * (psfn-framework-ccgdz.1) and return its resolvable reference — the
   * lineage's own `generationContextRef` (`turn:<turnId>`), so no identifier is
   * minted here.
   *
   * Record-first: the turn runtime calls this immediately after the fold and
   * before the reply is composed, so the record exists before anything can be
   * delivered on the strength of it.
   *
   * Failure is VISIBLE, not thrown. The lineage-consuming egress guard already
   * fails closed on its own terms; converting a custody-store outage into a
   * turn failure would silence the companion for a write that only records what
   * already happened. So a failure returns a NAMED absence instead of a ref —
   * mirroring the intake firewall's `receiptAbsence`, because a bare undefined
   * cannot tell an unwired deployment apart from a store that refused — and
   * announces itself on the health plane so repeats become one incident.
   */
  async recordTurnCustodySnapshot(input: {
    lineage: DisclosureLineage;
    turnId: TurnID;
    requestId: string;
    toolResultEdges?: ReadonlyMap<string, ToolResultCustodyEdge>;
  }): Promise<TurnCustodySnapshotOutcome> {
    const store = this.custodySnapshotStore;
    // Not a fault: this deployment wires no custody store, so nothing was
    // attempted and nothing is owed to an operator.
    if (!store) return { absenceReason: 'no_custody_store' };
    try {
      const snapshot = buildCustodySnapshot({
        lineage: input.lineage,
        turnId: input.turnId,
        requestId: input.requestId,
        ...(input.toolResultEdges ? { toolResultEdges: input.toolResultEdges } : {}),
      });
      const outcome = await store.record(snapshot);
      if (outcome === 'diverged') {
        // Two folds disagreed on one generation context — a recovered turn that
        // reconstructed a different admitted-source set, or a genuine turn-id
        // collision. The FIRST snapshot stands because it is the fold that
        // produced the delivered reply, so THIS turn may not point at it as
        // though it were its own proof; it records the divergence instead.
        log.error('Custody snapshot diverged from the stored record for this turn', {
          turnId: input.turnId,
          requestId: input.requestId,
          generationContextRef: snapshot.generationContextRef,
          rejectedContentSha256: custodySnapshotContentDigest(snapshot),
        });
        this.emitCustodySnapshotHealthEvent('diverged');
        return { absenceReason: 'diverged' };
      }
      return { ref: snapshot.generationContextRef };
    } catch (error) {
      log.error('Custody snapshot write failed; this turn has no durable custody record', {
        turnId: input.turnId,
        requestId: input.requestId,
        error: toErrorMessage(error),
      });
      this.emitCustodySnapshotHealthEvent('write_failed');
      return { absenceReason: 'write_failed' };
    }
  }

  /**
   * Persist this turn's per-block context source manifest
   * (psfn-framework-ccgdz.4) and return its resolvable reference — the same
   * `turn:<turnId>` key the custody snapshot uses, so no identifier is minted.
   *
   * Failure is VISIBLE, not thrown, for the same reason the snapshot's is: this
   * records what already happened, and turning a store outage into a turn
   * failure would silence the companion. An absent ref means the manifest is
   * missing — which is exactly what a reader must conclude, instead of the
   * synthesized display string this replaced, which resolved to nothing while
   * looking like a reference.
   */
  async recordTurnContextManifest(input: {
    turnId: TurnID;
    requestId: string;
    blocks: readonly ContextSourceManifestBlockInput[];
  }): Promise<string | undefined> {
    const store = this.custodySnapshotStore;
    if (!store) return undefined;
    try {
      const manifest = buildContextSourceManifest({
        turnId: input.turnId,
        blocks: input.blocks,
      });
      const outcome = await store.recordContextManifest(manifest);
      if (outcome === 'diverged') {
        // Two prompt assemblies disagreed on one generation context. The first
        // stands because it describes the prompt that produced the delivered
        // reply; a recovered turn legitimately re-assembles, so this is
        // reported rather than treated as corruption — but never silently.
        // 8nq3h: the ref below is STILL returned, unlike the custody
        // snapshot's. `generationContextRef` is the deterministic
        // `turn:<turnId>` key, so it resolves — but to the FIRST stored
        // manifest, i.e. a sibling fold of this same turn rather than the
        // assembly this call described. That caveat is documented on
        // `TurnRecord.contextManifestRef`; a reader needing fold-exact proof
        // uses `custodySnapshotRef`, whose absence on divergence is the claim.
        log.warn('Context source manifest diverged from the stored record for this turn', {
          turnId: input.turnId,
          requestId: input.requestId,
          generationContextRef: manifest.generationContextRef,
          rejectedContentSha256: contextSourceManifestContentDigest(manifest),
        });
      }
      return manifest.generationContextRef;
    } catch (error) {
      log.error('Context source manifest write failed; this turn has no durable context manifest', {
        turnId: input.turnId,
        requestId: input.requestId,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  setIntrospectionTurnSensitivityDecisions(
    decisions: IntrospectionTurnSensitivityDecisions | null,
  ): void {
    this.introspectionTurnSensitivityDecisions = decisions;
  }

  getActiveTurnCorrelation(): CorrelationMetadata | null {
    return this.activeTurnCorrelation;
  }

  getActiveTurnTaskKind(): string | null {
    return this.activeTurnTaskKind;
  }

  getActiveTurnIntent(): string | null {
    return this.activeTurnIntent;
  }

  getActiveTurnSessionIdentity(): TurnSessionIdentity | null {
    return this.activeTurnSessionIdentity;
  }

  setActiveTurnContext(
    correlation: CorrelationMetadata,
    taskKind: string | null,
    intent: string | null,
    turnSessionIdentity: TurnSessionIdentity,
  ): void {
    this.activeTurnCorrelation = correlation;
    this.activeTurnTaskKind = taskKind;
    this.activeTurnIntent = intent;
    this.activeTurnSessionIdentity = turnSessionIdentity;
  }

  clearActiveTurnContext(): void {
    this.activeTurnCorrelation = null;
    this.activeTurnTaskKind = null;
    this.activeTurnIntent = null;
    this.activeTurnSessionIdentity = null;
  }

  setActiveTurnCorrelation(correlation: CorrelationMetadata | null): void {
    this.activeTurnCorrelation = correlation;
  }

  setActiveTurnTaskKind(taskKind: string | null): void {
    this.activeTurnTaskKind = taskKind;
  }

  setActiveTurnIntent(intent: string | null): void {
    this.activeTurnIntent = intent;
  }

  recordIntentionalNoReplyDecision(input: {
    source: IntentionalNoReplyMetadata['source'];
    toolCallId?: string;
    reason?: string;
  }): IntentionalNoReplyMetadata | null {
    const correlation = this.activeTurnCorrelation;
    const turnId = correlation?.turnId as TurnID | undefined;
    if (!correlation || !turnId) {
      log.warn('Intentional no-reply requested without active turn correlation');
      return null;
    }
    const activeCorrelation = correlation;

    const decision: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: input.source,
      auditId: `no-reply:${turnId}:${input.toolCallId ?? 'unknown-tool-call'}`,
      decidedAt: Date.now(),
      turnId,
      ...(activeCorrelation.requestId ? { requestId: activeCorrelation.requestId } : {}),
      ...(activeCorrelation.channelId ? { channelId: activeCorrelation.channelId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.intentionalNoReplyDecisions.set(turnId, decision);
    this.emitTelemetry('agent.no_reply.intentional', {
      ...decision,
      ...this.withCorrelationPurpose(activeCorrelation, 'agent.no_reply.intentional'),
    });
    return decision;
  }

  consumeIntentionalNoReplyDecision(turnId: TurnID): IntentionalNoReplyMetadata | null {
    const decision = this.intentionalNoReplyDecisions.get(turnId) ?? null;
    if (decision) {
      this.intentionalNoReplyDecisions.delete(turnId);
    }
    return decision;
  }

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    this.postTurnActionInferers.push(inferer);
    return () => {
      const index = this.postTurnActionInferers.indexOf(inferer);
      if (index !== -1) {
        this.postTurnActionInferers.splice(index, 1);
      }
    };
  }

  registerIntentionPostTurnHook(hook: IntentionPostTurnHook): () => void {
    this.intentionPostTurnHooks.push(hook);
    return () => {
      const index = this.intentionPostTurnHooks.indexOf(hook);
      if (index !== -1) {
        this.intentionPostTurnHooks.splice(index, 1);
      }
    };
  }

  enqueuePostTurnBackgroundWork(inputs: readonly EnqueueBackgroundWorkInput[]): Promise<void> {
    if (!this.backgroundWorkSupervisor) {
      if (this.backgroundWorkDisabled) return Promise.resolve();
      return Promise.reject(new Error('Durable background work supervisor is not configured'));
    }
    return this.backgroundWorkSupervisor.enqueue(inputs);
  }

  beginForegroundBackgroundWork(logicalSessionId: string): ForegroundWorkLease | null {
    return this.backgroundWorkSupervisor?.beginForeground(logicalSessionId) ?? null;
  }

  async endForegroundBackgroundWork(lease: ForegroundWorkLease | null): Promise<void> {
    if (lease) await this.backgroundWorkSupervisor?.endForeground(lease);
  }

  async inferPostTurnActions(
    context: PostTurnInferenceContext,
  ): Promise<InferredPostTurnAction[]> {
    return inferPostTurnActionsForTurn({
      inferers: this.postTurnActionInferers,
      context,
      logger: log,
    });
  }

  async runIntentionPostTurnHooks(
    context: IntentionPostTurnHookContext,
    options?: IntentionPostTurnHookRunOptions,
  ): Promise<void> {
    await runIntentionPostTurnHooksForTurn({
      hooks: this.intentionPostTurnHooks,
      context,
      logger: log,
      ...(options ? { options } : {}),
    });
  }

  emitTurnStage(
    message: SubstrateMessage,
    turnStartMs: number,
    turnId: TurnID,
    requestId: string,
    stage: TurnStageName,
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ): EventMap['agent.turn.stage'] {
    const telemetry = buildTurnStageTelemetryForTurn({
      message,
      turnStartMs,
      turnId,
      requestId,
      stage,
      callType,
      payload,
    });
    log.debug('Turn stage telemetry', telemetry);
    this.emitTelemetry('agent.turn.stage', telemetry);
    return telemetry as EventMap['agent.turn.stage'];
  }

  resolveTurnCallType(
    message: SubstrateMessage,
    taskKind: string | undefined,
  ): ObservabilityCallType {
    return resolveTurnCallTypeForTurn(message, taskKind);
  }

  buildTurnCorrelation(
    message: SubstrateMessage,
    callType: ObservabilityCallType,
    turnId: TurnID,
    requestId: string,
    logicalSessionId: string,
  ): CorrelationMetadata {
    const resolvedSessionId = logicalSessionId.trim();
    if (!resolvedSessionId) {
      throw new Error('Turn correlation requires a captured logical session id');
    }
    const wyomingSessionId = message.routing?.wyoming?.sessionId?.trim();
    const sessionId = resolvedSessionId !== message.channelId
      ? resolvedSessionId
      : (wyomingSessionId || resolvedSessionId);
    const rootInitiationId = getRunChargeSnapshot()?.lineage.rootRunId.trim() || requestId;
    return buildTurnCorrelationForTurn(message, callType, turnId, requestId, {
      sessionId,
      rootInitiationId,
    }, this.companionId);
  }

  withCorrelationPurpose(
    correlation: CorrelationMetadata,
    purpose: string,
  ): CorrelationMetadata {
    return withCorrelationPurposeForTurn(correlation, purpose);
  }

  withAdaptiveCorrelation(
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ): Partial<CorrelationMetadata> {
    return withAdaptiveCorrelationForTurn(correlation, this.activeTurnCorrelation, purpose);
  }

  emitAdaptiveToolDecision(
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ): void {
    this.emitTelemetry('agent.tools.adaptive.decision', {
      ...payload,
      timestamp: Date.now(),
    });
  }

  emitTelemetry(event: string, payload: Record<string, unknown>): void {
    const telemetryBus = this.eventBus as unknown as {
      emit: (event: string, eventPayload: Record<string, unknown>) => Promise<void>;
    };
    telemetryBus.emit(event, payload).catch(error => {
      log.debug('Telemetry emit failed', {
        event,
        error: toErrorMessage(error),
      });
    });
  }

  recordUserMessage(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    contentOverride?: string,
    actorKind: SessionActorKind = 'unknown',
  ): number | null {
    return recordUserMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
      contentOverride,
      actorKind,
    });
  }

  recordSystemMessage(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    content: string,
    continuityUserId?: string,
  ): number | null {
    return this.sessionManager.recordSystemMessage(
      turnSessionIdentity.logicalSessionId,
      content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      continuityUserId,
      {
        turnId,
        requestId,
        sourceMessageId: message.id,
        sourceChannelId: turnSessionIdentity.sourceChannelId,
        channelMeta: resolveSessionChannelMeta(message),
        ...(message.routing?.intakeEnvelopes?.length
          ? { intakeEnvelopes: message.routing.intakeEnvelopes }
          : {}),
      },
    );
  }

  recordAssistantMessage(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    emotionSnapshot?: EmotionStateSnapshot | null,
    recoveryResponse?: AgentResponse,
    runtimeFallbackProvenance?: RuntimeFallbackProvenance,
  ): number | null {
    return recordAssistantMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
      recoveryResponse,
      runtimeFallbackProvenance,
    });
  }

  recordToolObservations(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ): TurnToolResultCustodyRecord[] {
    return recordToolObservationsForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    });
  }

  buildTurnRecord(input: {
    message: SubstrateMessage;
    turnSessionIdentity: TurnSessionIdentity;
    turnId: TurnID;
    requestId: string;
    startedAt: number;
    completedAt: number;
    userSessionEntryId: number | null;
    assistantSessionEntryId: number | null;
    response?: AgentResponse;
    model?: string;
    assistantMessageContent?: string;
    turnMessages: AgentMessage[];
    status?: TurnRecord['status'];
    continuationStop?: ParentTurnContinuationStop;
    promptMode: MessagePromptOverrideMode;
    promptText: string;
    trustLevel: TrustLevel;
    speakerRole: 'user' | 'system';
    canonicalContactKey?: string;
    retrievalProvenanceRefs: string[];
    turnSnapshot?: TurnSnapshot;
    turnObservability?: TurnObservabilityRecord;
    internalStateSnapshotRef?: string;
    persistedUserMessageContent?: string;
    custodySnapshotRef?: string;
    toolResultCustody?: ReadonlyMap<string, TurnToolResultCustodyRecord>;
  }, sessionReads: CapturedSessionReads): TurnRecord {
    if (input.message.channelId !== input.turnSessionIdentity.sourceChannelId) {
      throw new Error('TurnRecord physical source does not match the captured turn identity');
    }
    if (sessionReads.owner.logicalSessionId !== input.turnSessionIdentity.logicalSessionId
      || sessionReads.owner.sourceChannelId !== input.turnSessionIdentity.sourceChannelId) {
      throw new Error('TurnRecord session reads do not match the captured turn identity');
    }
    const roleEnvelopeRefs = sessionReads.getRoleEnvelopeRefsForEntries(
      [
        ...(input.userSessionEntryId != null ? [input.userSessionEntryId] : []),
        ...(input.assistantSessionEntryId != null ? [input.assistantSessionEntryId] : []),
      ],
    );
    const introspectionSensitivityDecision = this.introspectionTurnSensitivityDecisions?.consume({
      turnId: input.turnId,
      requestId: input.requestId,
    });
    const { turnSessionIdentity, ...turnRecordInput } = input;
    return buildTurnRecordForTurn({
      ...turnRecordInput,
      sessionId: turnSessionIdentity.logicalSessionId,
      roleEnvelopeRefs,
      hashPromptText: this.hashPromptText,
      ...(introspectionSensitivityDecision ? { introspectionSensitivityDecision } : {}),
    });
  }

  accumulateTurnUsage(messages: AgentMessage[]): TurnUsage {
    return accumulateTurnUsageForTurn(messages, this.resolveContextWindow());
  }

  buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
    return buildTurnToolSummaryForTurn(turnMessages);
  }
}
