// Partner Affect shadow ingest bridge (docs/partner-affect.md, slice 1).
//
// Shadow-only observer on the external telemetry spine. It subscribes to
// `external.telemetry.ingested`, screens partner-affect observation
// candidates through the fail-closed observation guard, and records the
// accepted/suppressed outcome in the shadow store for Garden inspection.
//
// Deliberately inert everywhere else: the bridge never touches prompts,
// emotion appraisal, memory candidacy, scheduling, notifications, or world
// actions, and emits only structural telemetry counters. Mirrors the
// SensorCognitionBridge subscription/lifecycle pattern.

import type {
  EventBus,
  ExternalTelemetryEvent,
} from '../../../shared/event-bus.js';
import {
  PARTNER_AFFECT_OBSERVATION_EVENT_TYPE,
  PARTNER_AFFECT_SCHEMA_VERSION,
  type PartnerAffectObservationDecision,
  type PartnerAffectShadowPolicy,
  type PartnerAffectShadowTelemetryCounter,
} from '../../../shared/contracts/partner-affect.js';
import { guardPartnerAffectObservation } from './observation-guard.js';
import type { PartnerAffectShadowStorePort } from './shadow-store-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';

const log = createComponentLogger('PartnerAffectShadowBridge');

export interface PartnerAffectShadowIngestBridgeOptions {
  eventBus: EventBus;
  policy: PartnerAffectShadowPolicy;
  store: PartnerAffectShadowStorePort;
  logger?: Pick<typeof log, 'warn'>;
  now?: () => number;
}

export interface PartnerAffectShadowIngestBridge {
  readonly active: boolean;
  unsubscribe(): void;
  handleTelemetryEvent(event: ExternalTelemetryEvent): Promise<void>;
}

function resolveReceivedAtMs(event: ExternalTelemetryEvent, nowMs: number): number {
  const parsed = Date.parse(event.receivedAt);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : nowMs;
}

class DefaultPartnerAffectShadowIngestBridge implements PartnerAffectShadowIngestBridge {
  readonly active = true;
  private readonly eventBus: EventBus;
  private readonly policy: PartnerAffectShadowPolicy;
  private readonly store: PartnerAffectShadowStorePort;
  private readonly logger: Pick<typeof log, 'warn'>;
  private readonly now: () => number;
  private readonly unsubscribeHandler: () => void;

  constructor(options: Required<Omit<PartnerAffectShadowIngestBridgeOptions, 'logger' | 'now'>> & {
    logger: Pick<typeof log, 'warn'>;
    now: () => number;
  }) {
    this.eventBus = options.eventBus;
    this.policy = options.policy;
    this.store = options.store;
    this.logger = options.logger;
    this.now = options.now;
    this.unsubscribeHandler = this.eventBus.on('external.telemetry.ingested', async ({ event }) => {
      await this.handleTelemetryEvent(event);
    });
  }

  unsubscribe(): void {
    this.unsubscribeHandler();
  }

  async handleTelemetryEvent(event: ExternalTelemetryEvent): Promise<void> {
    if (event.eventType !== PARTNER_AFFECT_OBSERVATION_EVENT_TYPE) return;
    try {
      await this.handleObservationCandidate(event);
    } catch (error) {
      this.logger.warn('Partner affect shadow bridge failed to process observation candidate', {
        error: toErrorMessage(error),
        eventId: event.id,
        source: event.source,
      });
      await this.emitTelemetry('store_error', ['subscriber_exception'], event);
    }
  }

  private async handleObservationCandidate(event: ExternalTelemetryEvent): Promise<void> {
    const nowMs = this.now();
    const receivedAtMs = resolveReceivedAtMs(event, nowMs);

    // Sprint-10 04-M1 posture: telemetry without an authenticated origin
    // context fails closed before any payload interpretation happens.
    let decision: PartnerAffectObservationDecision;
    const payloadSourceId = isRecord(event.payload) && typeof event.payload.sourceId === 'string'
      ? event.payload.sourceId.trim()
      : '';
    const sourceAuthorization = payloadSourceId
      ? this.policy.sources.find(source => source.sourceId === payloadSourceId)
      : undefined;
    const authenticatedSource = event.auth?.principalMode === 'api_key'
      && sourceAuthorization?.apiKeyPrincipalIds.includes(event.auth.principalId) === true;
    if (!authenticatedSource) {
      decision = {
        status: 'suppressed',
        suppressed: {
          schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
          observationKey: null,
          sourceId: payloadSourceId || null,
          signalFamily: null,
          partnerContactId: this.policy.partnerContactId,
          reasons: ['missing_authenticated_origin'],
          detail: 'authenticated ingress principal is not bound to the claimed observation source',
          receivedAtMs,
        },
      };
    } else {
      decision = guardPartnerAffectObservation({
        candidate: { payload: event.payload, receivedAtMs },
        policy: this.policy,
        nowMs,
      });
    }

    if (decision.status === 'suppressed') {
      await this.store.recordSuppressed(decision.suppressed);
      await this.store.pruneToRetentionCap(this.policy.maxRetainedObservations);
      await this.emitTelemetry('suppressed', decision.suppressed.reasons, event, {
        sourceId: decision.suppressed.sourceId ?? undefined,
        signalFamily: decision.suppressed.signalFamily ?? undefined,
      });
      return;
    }

    const { observation } = decision;
    const result = await this.store.recordAccepted(observation);
    if (!result.inserted) {
      await this.emitTelemetry('duplicate', ['duplicate_observation'], event, {
        sourceId: observation.sourceId,
        signalFamily: observation.signalFamily,
      });
      return;
    }
    await this.store.pruneToRetentionCap(this.policy.maxRetainedObservations);
    await this.emitTelemetry('accepted', [], event, {
      sourceId: observation.sourceId,
      signalFamily: observation.signalFamily,
    });
  }

  private async emitTelemetry(
    counter: PartnerAffectShadowTelemetryCounter,
    reasons: readonly string[],
    event: ExternalTelemetryEvent,
    context: { sourceId?: string; signalFamily?: string } = {},
  ): Promise<void> {
    try {
      await this.eventBus.emit('emotion.partner_affect.shadow.telemetry', {
        counter,
        reasons: [...reasons],
        eventId: event.id,
        ...(context.sourceId ? { sourceId: context.sourceId } : {}),
        ...(context.signalFamily ? { signalFamily: context.signalFamily } : {}),
        timestamp: this.now(),
      });
    } catch (error) {
      this.logger.warn('Partner affect shadow bridge telemetry emit failed', {
        error: toErrorMessage(error),
        eventId: event.id,
        counter,
      });
    }
  }
}

class InactivePartnerAffectShadowIngestBridge implements PartnerAffectShadowIngestBridge {
  readonly active = false;

  unsubscribe(): void {
    // No-op: a disabled shadow policy is byte-identical to no bridge at all.
  }

  async handleTelemetryEvent(): Promise<void> {
    // No-op: a disabled shadow policy is byte-identical to no bridge at all.
  }
}

/**
 * Create the shadow ingest bridge. Fail-inert: unless the policy is enabled
 * (which the config contract only allows with an exact canonical partner
 * binding), no subscription is made and nothing is recorded.
 */
export function createPartnerAffectShadowIngestBridge(
  options: PartnerAffectShadowIngestBridgeOptions,
): PartnerAffectShadowIngestBridge {
  if (!options.policy.enabled || options.policy.partnerContactId === null) {
    return new InactivePartnerAffectShadowIngestBridge();
  }
  return new DefaultPartnerAffectShadowIngestBridge({
    eventBus: options.eventBus,
    policy: options.policy,
    store: options.store,
    logger: options.logger ?? log,
    now: options.now ?? Date.now,
  });
}
