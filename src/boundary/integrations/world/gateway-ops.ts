import type {
  GatewayOpsPort,
  HomeAssistantOperations,
} from '../../gateway/gateway-ops-port.js';
import type {
  HomeAssistantCallServiceResult,
  HomeAssistantGetStatesResult,
} from '../../gateway/protocol.js';
import type {
  WorldCallServiceParams,
  WorldGetStatesParams,
  WorldOperations,
} from './ops.js';

/**
 * Gateway-backed `WorldOperations`: forwards the agent-side world tool's read
 * and control calls to the privileged Home Assistant gateway methods (bead .8).
 * The gateway holds the HA token and enforces the SSRF lane; this class only
 * marshals already-validated `entity_id`/`service` payloads across the RPC.
 */
export class GatewayWorldOps implements WorldOperations {
  private readonly homeAssistant: HomeAssistantOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'homeAssistant'> | HomeAssistantOperations) {
    this.homeAssistant = 'homeAssistant' in gatewayOps ? gatewayOps.homeAssistant : gatewayOps;
  }

  async getStates(params: WorldGetStatesParams = {}): Promise<HomeAssistantGetStatesResult> {
    return this.homeAssistant.getStates(params);
  }

  async callService(params: WorldCallServiceParams): Promise<HomeAssistantCallServiceResult> {
    return this.homeAssistant.callService(params);
  }
}
