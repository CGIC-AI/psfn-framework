// ── Deduplicated operator alert delivery for runtime incidents (bead psfn-framework-7qeo1.24.5) ──
//
// One incident, one alert. Not one alert per health event, per detector cycle,
// per process restart, or per sink.
//
// The whole design is a single question asked of every `runtime.health.event`:
// "is this a statement about an incident nobody has been told about yet?" The
// answer comes from two places, in this order:
//
//   1. The in-process ledger, keyed by the incident's `correlationId`. It
//      remembers when this process last alerted about that incident and gates a
//      re-alert on the owner-file `realertCooldownMs` — deliberately a longer
//      clock than the detector cooldown, which only governs how often an open
//      episode re-states itself in the stream.
//   2. The persisted stream, when the ledger has never seen the incident. If
//      the stream already holds an earlier statement of it, an earlier process
//      alerted and then died or restarted; the ledger is seeded from that
//      statement's timestamp instead of paging the operator again. That is what
//      makes deduplication survive a crash loop, which is precisely when an
//      in-memory-only ledger would produce an alert storm.
//
// Delivery reuses the existing operator-alert seam unchanged: the gateway
// satisfies {@link OperatorIncidentAlertSink} with its own dispatcher, the agent
// with `GatewayClient.notifyOperator`. This module owns no sink, no retry, and
// no fan-out policy.
//
// Since psfn-framework-bznbn it reaches that seam THROUGH the human escalation
// control plane rather than beside it. The migration is deliberately additive:
// the two questions above, the in-process ledger, the stream re-anchor, and the
// rendered notification are untouched, and the alert an operator receives is
// byte-identical. What the plane adds is a durable ledger row per incident, a
// durable attempt row per `idempotencyKey`, and one Garden surface where an
// operator can say what they did about it. It adds no second cooldown: the
// owner file requires `humanEscalation.routes.runtime_incident.cooldownMs` to
// be zero precisely so the clock below stays the only one.
//
// The alert-sink-unconfigured case is not an exception to any of the above. It
// is an incident like the others, it is deduplicated like the others, and the
// delivery attempt reports `unconfigured` because that is the literal truth.
// The operator still learns about it through the two paths that remain: an
// error log naming the incident id, and the same incident on the Garden
// timeline (child .6) under that identical id.

import type { EventBus } from '../../shared/event-bus.js';
import type { HealthEvent } from '../../shared/contracts/health-event.js';
import type { IncidentAlertsConfig } from '../../system/config/scheduler-config/health-detectors.js';
import {
  classifyIncidentStatement,
  type IncidentBundle,
  type IncidentStatementPhase,
} from '../../shared/observability/incident-alerts/contracts.js';
import type {
  IncidentInvestigator,
} from '../../shared/observability/incident-alerts/investigator.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { NotifyNtfyParams, OperatorAlertResult } from './protocol.js';
import type {
  HumanEscalationControlPlane,
} from '../../shared/escalation/control-plane.js';
import { renderIncidentAlert } from './incident-alert-render.js';

const log = createComponentLogger('IncidentAlertDelivery');

/**
 * Garden route the escalation deep-links to. The incident timeline already
 * lists every incident under the id the alert carries, so the escalation points
 * at that surface rather than minting a second view of the same rows.
 */
const INCIDENT_GARDEN_DETAIL_PATH = '/subsystem-health';

/**
 * Delivery seam. Structurally satisfied by both
 * `GatewayOperatorAlertDispatcher.dispatch` (gateway process, in-process) and
 * `GatewayClient.notifyOperator` (agent process, over the gateway RPC), so a
 * companion-owned incident and a system-owned one reach the same operator
 * sinks without this module owning a second delivery path.
 */
export interface OperatorIncidentAlertSink {
  dispatch(params: NotifyNtfyParams): Promise<OperatorAlertResult>;
}

interface IncidentAlertLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** What one health event produced. Returned so tests and callers can assert it. */
export type IncidentAlertOutcome =
  /** Not an incident statement at all: ordinary evidence, or a healthy runtime. */
  | { status: 'ignored' }
  | {
      status: 'suppressed';
      incidentId: string;
      reason: 'within_cooldown' | 'stated_by_earlier_process' | 'close_notice_disabled'
        | 'already_notified';
    }
  | { status: 'delivered'; incidentId: string; phase: IncidentStatementPhase }
  | {
      status: 'undeliverable';
      incidentId: string;
      phase: IncidentStatementPhase;
      reason: 'no_sink' | 'unconfigured' | 'delivery_failed';
    };

export interface IncidentAlertDeliveryOptions {
  investigator: IncidentInvestigator;
  /**
   * The governed path to a human. Every alert this module decides to send is
   * raised on the plane as a `runtime_incident`, which routes it to the same
   * operator-alert dispatcher this module used to call directly, records the
   * incident durably, and refuses to dispatch twice for one idempotency key.
   *
   * The dispatcher is still resolved per alert, one layer down in the sink
   * adapter: the gateway subscribes this path before it builds its RPC server —
   * it has to, because the `operator_alert_sinks_unconfigured` incident is
   * emitted during startup — so the dispatcher genuinely does not exist yet at
   * that moment, and saying so is more honest than deferring the subscription
   * and losing the event.
   */
  escalation: HumanEscalationControlPlane<NotifyNtfyParams>;
  policy: () => IncidentAlertsConfig;
  now?: () => number;
  logger?: IncidentAlertLogger;
}

interface LedgerEntry {
  lastAlertAtMs: number;
  alertCount: number;
  closed: boolean;
}

export interface IncidentAlertDelivery {
  handle(event: HealthEvent): Promise<IncidentAlertOutcome>;
}

/**
 * Newest statement of this incident that is NOT the triggering event. Its
 * presence means an earlier cycle — very likely in an earlier process — already
 * had the chance to alert, so this process seeds its ledger from that time
 * rather than treating a continuing incident as a new one.
 */
function priorStatementAtMs(bundle: IncidentBundle, triggerEventId: string): number | null {
  let latest: number | null = null;
  for (const entry of bundle.incident.timeline) {
    if (entry.eventId === triggerEventId) continue;
    if (entry.phase === undefined) continue;
    if (latest === null || entry.recordedAtMs > latest) latest = entry.recordedAtMs;
  }
  return latest;
}

export function createIncidentAlertDelivery(
  options: IncidentAlertDeliveryOptions,
): IncidentAlertDelivery {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? log;
  const ledger = new Map<string, LedgerEntry>();

  function remember(incidentId: string, entry: LedgerEntry, capacity: number): void {
    ledger.delete(incidentId);
    ledger.set(incidentId, entry);
    // Insertion-ordered eviction. A pruned incident costs one stream read to
    // re-anchor, never a duplicate alert, because the durable dedup anchor is
    // the persisted stream rather than this map.
    while (ledger.size > capacity) {
      const oldest = ledger.keys().next();
      if (oldest.done) break;
      ledger.delete(oldest.value);
    }
  }

  /**
   * Content-free facts about one incident, in the escalation plane's shape.
   * Every value is drawn from the health envelope's closed vocabularies, its
   * numeric/boolean evidence, or its opaque identifiers — the same guarantee
   * the rendered alert has, now enforced a second time by the plane's own
   * label and evidence admission.
   */
  function escalationLabels(bundle: IncidentBundle): string[] {
    const family = bundle.incident.family;
    return family === null ? [bundle.incident.code] : [bundle.incident.code, family];
  }

  /**
   * One alert, one key. The sequence comes from the DURABLE escalation ledger
   * rather than the in-process ledger below, and that distinction is
   * load-bearing: the in-process counter restarts at zero on every boot, so
   * after a second restart it would re-mint a key an earlier process already
   * recorded, and the plane would correctly refuse to dispatch it — silently
   * costing an operator the re-alert that says the fault is still going. The
   * in-process ledger keeps its own job, which is gating the cooldown.
   */
  async function deliver(
    bundle: IncidentBundle,
    phase: IncidentStatementPhase,
  ): Promise<IncidentAlertOutcome> {
    const incidentId = bundle.incident.incidentId;
    const sequence = await options.escalation.raiseCount('runtime_incident', incidentId) + 1;
    const notice = renderIncidentAlert(bundle, phase, sequence);
    const idempotencyKey = notice.idempotencyKey;
    if (!idempotencyKey) {
      throw new Error('Rendered incident alerts must carry an idempotency key');
    }
    const raised = await options.escalation.raise({
      kind: 'runtime_incident',
      severity: bundle.incident.severity,
      owner: bundle.incident.owner,
      // The condition an operator resolves is the INCIDENT; the attempt the
      // plane deduplicates is this one rendered notice. Same two keys the alert
      // path has always used, now durable.
      dedupeKey: incidentId,
      idempotencyKey,
      sourceRef: incidentId,
      labels: escalationLabels(bundle),
      evidence: bundle.incident.evidence,
      detailPath: INCIDENT_GARDEN_DETAIL_PATH,
      raisedAtMs: now(),
      notice,
    });

    if (raised.status === 'delivered') {
      logger.info('Runtime incident operator alert delivered', {
        incidentId,
        phase,
        code: bundle.incident.code,
        severity: bundle.incident.severity,
        escalationId: raised.escalationId,
      });
      return { status: 'delivered', incidentId, phase };
    }
    if (raised.status === 'undeliverable') {
      if (raised.reason === 'no_sink') {
        logger.error('Runtime incident could not be alerted: no operator alert sink is wired', {
          incidentId,
          phase,
          code: bundle.incident.code,
          severity: bundle.incident.severity,
          component: bundle.incident.component,
          ownerKind: bundle.incident.owner.kind,
        });
      } else if (raised.reason === 'unconfigured') {
        logger.error('Runtime incident operator alert has nowhere to go', {
          incidentId,
          phase,
          code: bundle.incident.code,
          severity: bundle.incident.severity,
        });
      } else {
        // Contained but never swallowed: the dispatcher throws only when every
        // configured sink failed, and that is itself operator-visible news.
        logger.error('Runtime incident operator alert delivery failed', {
          incidentId,
          phase,
          code: bundle.incident.code,
        });
      }
      return { status: 'undeliverable', incidentId, phase, reason: raised.reason };
    }
    if (raised.status === 'replayed') {
      // Another process was raising this same notice at the same instant and won
      // the plane's attempt claim, so a human HAS been paged — by them, once.
      // This is a normal outcome of two processes reacting to one incident, not
      // a routing fault: the sequence comes from a durable count read before the
      // raise, so two racers legitimately mint the same key and exactly one of
      // them dispatches.
      logger.info('Runtime incident alert was already dispatched by a concurrent raise', {
        incidentId,
        phase,
        code: bundle.incident.code,
        outcome: raised.outcome,
        escalationId: raised.escalationId,
      });
      return { status: 'suppressed', incidentId, reason: 'already_notified' };
    }
    // Everything below is a state the owner file makes unreachable for this
    // kind, so reaching it means the routing invariants were bypassed rather
    // than that an alert was quietly dropped. Failing loudly is the only
    // outcome that does not silently lose a page.
    throw new Error(
      `Runtime incident ${incidentId} was escalated but not alerted (${raised.status}); `
      + 'humanEscalation.routes.runtime_incident must route to operator_alert with a zero '
      + 'cooldown',
    );
  }

  return {
    async handle(event: HealthEvent): Promise<IncidentAlertOutcome> {
      const statement = classifyIncidentStatement(event);
      if (!statement) return { status: 'ignored' };
      const policy = options.policy();
      const incidentId = statement.incidentId;
      const existing = ledger.get(incidentId);
      const nowMs = now();

      if (statement.phase === 'closed') {
        if (!policy.closeNotice) {
          if (existing) remember(incidentId, { ...existing, closed: true }, policy.ledgerCapacity);
          return { status: 'suppressed', incidentId, reason: 'close_notice_disabled' };
        }
        if (existing?.closed) {
          return { status: 'suppressed', incidentId, reason: 'already_notified' };
        }
        const bundle = await options.investigator.investigate(event);
        if (!bundle) return { status: 'ignored' };
        const outcome = await deliver(bundle, 'closed');
        remember(incidentId, {
          lastAlertAtMs: nowMs,
          alertCount: (existing?.alertCount ?? 0) + 1,
          closed: true,
        }, policy.ledgerCapacity);
        return outcome;
      }

      if (existing) {
        if (nowMs - existing.lastAlertAtMs < policy.realertCooldownMs) {
          return { status: 'suppressed', incidentId, reason: 'within_cooldown' };
        }
        const bundle = await options.investigator.investigate(event);
        if (!bundle) return { status: 'ignored' };
        const outcome = await deliver(bundle, 'opened');
        remember(incidentId, {
          lastAlertAtMs: nowMs,
          alertCount: existing.alertCount + 1,
          closed: false,
        }, policy.ledgerCapacity);
        return outcome;
      }

      const bundle = await options.investigator.investigate(event);
      if (!bundle) return { status: 'ignored' };
      const prior = priorStatementAtMs(bundle, event.eventId);
      if (prior !== null && nowMs - prior < policy.realertCooldownMs) {
        // A continuing incident this process has not seen before. Seed the
        // ledger from the stream so the next re-alert lands one full cooldown
        // after the runtime last stated it, not one cooldown after this boot.
        remember(incidentId, {
          lastAlertAtMs: prior,
          alertCount: 1,
          closed: false,
        }, policy.ledgerCapacity);
        return { status: 'suppressed', incidentId, reason: 'stated_by_earlier_process' };
      }
      const outcome = await deliver(bundle, 'opened');
      remember(incidentId, {
        lastAlertAtMs: nowMs,
        alertCount: 1,
        closed: false,
      }, policy.ledgerCapacity);
      return outcome;
    },
  };
}

/**
 * Subscribe alert delivery to a process bus, beside the persisting stream sink.
 *
 * Both subscribers see the same event and run concurrently; the investigator
 * splices the triggering event into its bundle, so the alert never depends on
 * the write having landed first. A delivery fault is logged and contained here
 * for the same reason the stream sink contains a persistence fault: the
 * subsystem reporting a failure must not become a second failure.
 */
export function subscribeIncidentAlerts(deps: {
  eventBus: EventBus;
  delivery: IncidentAlertDelivery;
  logger?: IncidentAlertLogger;
}): () => void {
  const logger = deps.logger ?? log;
  return deps.eventBus.on('runtime.health.event', async (data) => {
    try {
      await deps.delivery.handle(data.event);
    } catch (error) {
      logger.error('Runtime incident alert evaluation failed', {
        code: data.event.code,
        correlationId: data.event.correlationId,
        error: toErrorMessage(error),
      });
    }
  });
}
