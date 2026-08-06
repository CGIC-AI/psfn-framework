import type { IcpOwnAvailabilityResult } from '../../boundary/gateway/icp-autonomy-contract.js';
import {
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  type IcpAvailabilityState,
} from '../../shared/contracts/icp-autonomy.js';
import type { FleetFatiguePosture } from '../../shared/telemetry/fleet-posture.js';

export interface IcpRuntimeAvailabilityGatewayPort {
  refreshRuntimeAvailability(input: {
    state: IcpAvailabilityState;
    expiresAtMs: number;
  }): Promise<IcpOwnAvailabilityResult>;
  clearRuntimeAvailability(): Promise<IcpOwnAvailabilityResult>;
}

export interface IcpRuntimeAvailabilityController {
  refresh(): Promise<IcpOwnAvailabilityResult>;
}

export function createIcpRuntimeAvailabilityController(input: {
  gateway: IcpRuntimeAvailabilityGatewayPort;
  isEnabled(): boolean;
  readFatigueState(): FleetFatiguePosture;
  now?: () => number;
}): IcpRuntimeAvailabilityController {
  const now = input.now ?? Date.now;
  return {
    async refresh() {
      if (!input.isEnabled()) {
        return await input.gateway.clearRuntimeAvailability();
      }
      const issuedAtMs = now();
      return await input.gateway.refreshRuntimeAvailability({
        state: input.readFatigueState() === 'exhausted' ? 'resting' : 'available',
        expiresAtMs: issuedAtMs + MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
      });
    },
  };
}
