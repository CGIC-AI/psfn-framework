// Multi-companion violation alarms and the bounded fleet connection snapshot:
// loud fail-closed alarm (log + DENY audit + operator ntfy), the in-memory
// violation ring, and the read-only fleet health view built from it.
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { GatewayCredentialPresenceResult } from '../protocol.js';
import type { FleetCompanionPostureSummary } from '../../../shared/telemetry/fleet-posture.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  GatewayConnectionHealth,
  GatewayConnectionState,
} from './connection-status.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');

// ── Fleet health snapshot (bounded multi-companion fleet view) ──
// Cheap, read-only view over state the gateway already tracks: the companion
// connection registry, latest bounded agent posture, and an in-memory ring of
// multi-companion violation alarms. The gateway never reads companion stores.

const COMPANION_VIOLATION_LOG_LIMIT = 1_000;
export const FLEET_RECENT_VIOLATION_WINDOW_MS = 60 * 60 * 1_000;

interface CompanionViolationEvent {
  event: string;
  companionId?: string;
  /** Value-free provider/channel credential inventory for the Garden status UI. */
  credentialPresence?: GatewayCredentialPresenceResult;
  at: number;
}

export interface GatewayFleetCompanionConnection {
  companionId: CompanionId;
  /** Live connection state; offline connections are removed, never reported. */
  state: Exclude<GatewayConnectionState, 'offline'>;
  health: GatewayConnectionHealth;
  stateReason: string;
  connectedAt: number;
  lastSeenAt: number;
  /** Latest validated content-free posture, attributed by this bound connection. */
  posture?: FleetCompanionPostureSummary;
}

export interface GatewayFleetConnectionSnapshot {
  generatedAt: number;
  /** Currently-identified companion connections (one per bound companionId). */
  connections: GatewayFleetCompanionConnection[];
  /** Last activity per companionId, retained across disconnects. */
  lastSeenByCompanionId: Record<string, number>;
  /** Violation alarms in the recent window, keyed by attributed companionId. */
  recentViolationsByCompanionId: Record<string, number>;
  /** Recent violation alarms with no companion attribution. */
  unattributedRecentViolationCount: number;
  recentViolationWindowMs: number;
}

export class GatewayCompanionViolations {
  private readonly companionViolationLog: CompanionViolationEvent[] = [];

  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'audit'
      | 'auditComplete'
      | 'ntfyNotifier'
      | 'companionConnections'
      | 'companionLastSeen'
      | 'companionPostures'
      | 'connectionStatuses'
      | 'refreshConnectionHealth'
    >,
  ) {}

  /**
   * Loud fail-closed alarm for multi-companion routing/identity violations:
   * synchronous error log, gateway audit entry (DENY), and an operator ntfy
   * alert when configured. Never throws.
   */
  alarmCompanionViolation(
    event: string,
    message: string,
    details: Record<string, unknown>,
  ): void {
    log.error(`Multi-companion violation [${event}]: ${message}`, details);
    this.recordCompanionViolation(event, details);
    const startedAt = Date.now();
    void (async () => {
      const auditId = await this.ports.audit(`gateway.companion.${event}`, 'DENY', details);
      await this.ports.auditComplete(auditId, startedAt, message);
      if (this.ports.ntfyNotifier.isConfigured()) {
        await this.ports.ntfyNotifier.send({
          message: `${message} (${JSON.stringify(details)})`,
          title: 'Multi-companion routing violation',
          priority: 5,
          sender: {
            kind: 'system',
            provenance: 'system.operator_alert.multi_companion_routing',
          },
        });
      }
    })().catch((error: unknown) => {
      log.error('Failed to record multi-companion violation alarm', {
        event,
        error: toErrorMessage(error),
      });
    });
  }

  recordCompanionViolation(event: string, details: Record<string, unknown>): void {
    const companionId = extractViolationCompanionId(details);
    this.companionViolationLog.push({
      event,
      ...(companionId !== undefined ? { companionId } : {}),
      at: Date.now(),
    });
    if (this.companionViolationLog.length > COMPANION_VIOLATION_LOG_LIMIT) {
      this.companionViolationLog.splice(
        0,
        this.companionViolationLog.length - COMPANION_VIOLATION_LOG_LIMIT,
      );
    }
  }

  /**
   * Read-only fleet health view: identified companion
   * connections, last-seen activity (retained across disconnects), and recent
   * multi-companion violation counts. Available for bounded, server-side fleet
   * projections and internal operations; never mutates connection state.
   */
  getFleetConnectionSnapshot(now = Date.now()): GatewayFleetConnectionSnapshot {
    this.ports.refreshConnectionHealth(now);

    const connections: GatewayFleetCompanionConnection[] = [];
    for (const [companionId, conn] of this.ports.companionConnections.entries()) {
      const status = this.ports.connectionStatuses.get(conn);
      if (!status || status.state === 'offline') {
        continue;
      }
      const posture = this.ports.companionPostures.read(conn, companionId, now);
      connections.push({
        companionId,
        state: status.state,
        health: status.health,
        stateReason: status.stateReason,
        connectedAt: status.connectedAt,
        lastSeenAt: status.lastHealthcheckAt,
        ...(posture ? { posture } : {}),
      });
    }

    const windowStart = now - FLEET_RECENT_VIOLATION_WINDOW_MS;
    const recentViolationsByCompanionId: Record<string, number> = {};
    let unattributedRecentViolationCount = 0;
    for (const violation of this.companionViolationLog) {
      if (violation.at < windowStart) {
        continue;
      }
      if (violation.companionId) {
        recentViolationsByCompanionId[violation.companionId] =
          (recentViolationsByCompanionId[violation.companionId] ?? 0) + 1;
      } else {
        unattributedRecentViolationCount += 1;
      }
    }

    return {
      generatedAt: now,
      connections,
      lastSeenByCompanionId: Object.fromEntries(this.ports.companionLastSeen),
      recentViolationsByCompanionId,
      unattributedRecentViolationCount,
      recentViolationWindowMs: FLEET_RECENT_VIOLATION_WINDOW_MS,
    };
  }
}

/**
 * Best-effort companion attribution for a violation alarm. Violation `details`
 * carry the companion under different keys depending on the event; placeholder
 * markers like "(unidentified)" are not real ids and stay unattributed.
 */
function extractViolationCompanionId(details: Record<string, unknown>): string | undefined {
  for (const key of ['companionId', 'boundCompanionId', 'senderCompanionId']) {
    const value = details[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('(')) continue;
    return trimmed;
  }
  return undefined;
}
