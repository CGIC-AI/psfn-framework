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
// no fan-out policy — psfn-framework-bznbn owns that redesign and sequences
// after this bead.
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
import { renderIncidentAlert } from './incident-alert-render.js';

const log = createComponentLogger('IncidentAlertDelivery');

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
   * Resolved per alert rather than injected once. The gateway subscribes this
   * path before it builds its RPC server — it has to, because the
   * `operator_alert_sinks_unconfigured` incident is emitted during startup —
   * so the sink genuinely does not exist yet at that moment, and saying so is
   * more honest than deferring the subscription and losing the event.
   */
  resolveSink: () => OperatorIncidentAlertSink | null;
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

  async function deliver(
    bundle: IncidentBundle,
    phase: IncidentStatementPhase,
    sequence: number,
  ): Promise<IncidentAlertOutcome> {
    const incidentId = bundle.incident.incidentId;
    const sink = options.resolveSink();
    if (!sink) {
      logger.error('Runtime incident could not be alerted: no operator alert sink is wired', {
        incidentId,
        phase,
        code: bundle.incident.code,
        severity: bundle.incident.severity,
        component: bundle.incident.component,
        ownerKind: bundle.incident.owner.kind,
      });
      return { status: 'undeliverable', incidentId, phase, reason: 'no_sink' };
    }
    let result: OperatorAlertResult;
    try {
      result = await sink.dispatch(renderIncidentAlert(bundle, phase, sequence));
    } catch (error) {
      // Contained but never swallowed: the dispatcher throws only when every
      // configured sink failed, and that is itself operator-visible news.
      logger.error('Runtime incident operator alert delivery failed', {
        incidentId,
        phase,
        code: bundle.incident.code,
        error: toErrorMessage(error),
      });
      return { status: 'undeliverable', incidentId, phase, reason: 'delivery_failed' };
    }
    if (result.outcome === 'unconfigured') {
      logger.error('Runtime incident operator alert has nowhere to go', {
        incidentId,
        phase,
        code: bundle.incident.code,
        severity: bundle.incident.severity,
        warning: result.warning,
      });
      return { status: 'undeliverable', incidentId, phase, reason: 'unconfigured' };
    }
    logger.info('Runtime incident operator alert delivered', {
      incidentId,
      phase,
      code: bundle.incident.code,
      severity: bundle.incident.severity,
      sinks: result.deliveries.map(delivery => `${delivery.sink}:${delivery.status}`),
    });
    return { status: 'delivered', incidentId, phase };
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
        const outcome = await deliver(bundle, 'closed', (existing?.alertCount ?? 0) + 1);
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
        const outcome = await deliver(bundle, 'opened', existing.alertCount + 1);
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
      const outcome = await deliver(bundle, 'opened', 1);
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
