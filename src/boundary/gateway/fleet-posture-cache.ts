import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  FLEET_POSTURE_EXPIRY_TIMEOUT_MS,
  parseFleetCompanionPosture,
  type FleetCompanionPostureSummary,
} from '../../shared/telemetry/fleet-posture.js';

interface BoundPosture {
  readonly companionId: CompanionId;
  summary?: FleetCompanionPostureSummary;
}

/**
 * Latest-only, process-local posture cache. Identity never arrives inside the
 * posture payload: the authenticated connection binding is the sole
 * attribution authority.
 */
export class GatewayFleetPostureCache<TConnection extends object> {
  private readonly byConnection = new WeakMap<TConnection, BoundPosture>();

  bind(connection: TConnection, companionId: CompanionId): void {
    const existing = this.byConnection.get(connection);
    if (existing && existing.companionId !== companionId) {
      throw new Error('Fleet posture connection cannot be rebound to another companion');
    }
    if (!existing) {
      this.byConnection.set(connection, { companionId });
    }
  }

  record(
    connection: TConnection,
    authenticatedCompanionId: CompanionId,
    value: unknown,
    nowMs = Date.now(),
  ): FleetCompanionPostureSummary {
    const bound = this.byConnection.get(connection);
    if (!bound || bound.companionId !== authenticatedCompanionId) {
      throw new Error('Fleet posture requires an authenticated companion connection binding');
    }
    const summary = parseFleetCompanionPosture(value, nowMs);
    if (bound.summary && summary.updatedAt < bound.summary.updatedAt) {
      throw new Error('Fleet posture update is older than the cached connection posture');
    }
    if (bound.summary
      && summary.updatedAt === bound.summary.updatedAt
      && JSON.stringify(summary) !== JSON.stringify(bound.summary)) {
      throw new Error('Fleet posture update conflicts with the cached timestamp');
    }
    bound.summary = summary;
    return summary;
  }

  read(
    connection: TConnection,
    authenticatedCompanionId: CompanionId,
    nowMs = Date.now(),
  ): FleetCompanionPostureSummary | undefined {
    const bound = this.byConnection.get(connection);
    if (!bound || bound.companionId !== authenticatedCompanionId) return undefined;
    if (bound.summary && nowMs - bound.summary.updatedAt > FLEET_POSTURE_EXPIRY_TIMEOUT_MS) {
      delete bound.summary;
      return undefined;
    }
    return bound.summary;
  }

  unbind(connection: TConnection): void {
    this.byConnection.delete(connection);
  }
}
