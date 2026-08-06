import {
  createIcpRuntimeAvailabilityController,
  type IcpRuntimeAvailabilityGatewayPort,
} from '../../core/icp/runtime-availability.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { FleetFatiguePosture } from '../../shared/telemetry/fleet-posture.js';

export interface AgentIcpRuntimeAvailability {
  stop(): void;
}

export async function startIcpRuntimeAvailability(input: {
  eventBus: EventBus;
  gateway: IcpRuntimeAvailabilityGatewayPort;
  isEnabled(): boolean;
  readFatigueState(): FleetFatiguePosture;
  now?: () => number;
}): Promise<AgentIcpRuntimeAvailability> {
  const controller = createIcpRuntimeAvailabilityController({
    gateway: input.gateway,
    isEnabled: input.isEnabled,
    readFatigueState: input.readFatigueState,
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
