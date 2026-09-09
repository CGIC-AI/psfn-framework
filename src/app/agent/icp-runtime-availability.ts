import {
  createIcpRuntimeAvailabilityController,
  type IcpRuntimeAvailabilityGatewayPort,
} from '../../core/icp/runtime-availability.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { FleetFatiguePosture } from '../../shared/telemetry/fleet-posture.js';

const log = createComponentLogger('IcpRuntimeAvailability');

export interface AgentIcpRuntimeAvailability {
  stop(): void;
}

/**
 * The fleet-only wiring the runtime-availability lane needs: the gateway ICP
 * availability port plus the two runtime reads that decide what to publish.
 * Null in a deployment shape that carries no ICP lane at all — a single-release
 * companion, whose gateway is built without an ICP autonomy broker.
 */
export interface IcpRuntimeAvailabilityLane {
  gateway: IcpRuntimeAvailabilityGatewayPort;
  isEnabled(): boolean;
  readFatigueState(): FleetFatiguePosture;
}

export async function startIcpRuntimeAvailability(input: {
  eventBus: EventBus;
  lane: IcpRuntimeAvailabilityLane | null;
  now?: () => number;
}): Promise<AgentIcpRuntimeAvailability> {
  // psfn-framework-n97hp: `capability.tier.changed` is delivered with
  // `emitRequired` whenever `external.companion` is withdrawn, so a consumer
  // must exist in EVERY deployment shape — a required event with no registered
  // consumer throws, and the owner's capability-tier save then reports a
  // diverged notice delivery. A single-companion release has no ICP lane to
  // fence, and must not reach for one: `controller.refresh()` on a withdrawal
  // calls `gateway.clearRuntimeAvailability()`, whose
  // `companion.availability.clear_runtime` RPC raises "ICP autonomy broker is
  // not configured on this gateway" when the gateway runs single-companion. So
  // the listener stays registered and records that there was nothing to fence.
  const lane = input.lane;
  if (!lane) {
    const unregisterCapabilityChange = input.eventBus.on('capability.tier.changed', (event) => {
      log.info('Capability tier changed with no ICP runtime-availability lane to fence', {
        previousTier: event.previousTier,
        currentTier: event.currentTier,
        externalCompanionWithdrawn: event.withdrawnTokens.includes('external.companion'),
      });
    });
    return {
      stop() {
        unregisterCapabilityChange();
      },
    };
  }
  const controller = createIcpRuntimeAvailabilityController({
    gateway: lane.gateway,
    isEnabled: () => lane.isEnabled(),
    readFatigueState: () => lane.readFatigueState(),
    ...(input.now ? { now: input.now } : {}),
  });
  await controller.refresh();
  const unregisterHeartbeat = input.eventBus.on('schedule.healthcheck', async () => {
    await controller.refresh();
  });
  const unregisterCapabilityChange = input.eventBus.on('capability.tier.changed', async () => {
    await controller.refresh();
  });
  return {
    stop() {
      unregisterHeartbeat();
      unregisterCapabilityChange();
    },
  };
}
