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
import { getRequestContext } from '../../../primitives/llm/request-context.js';

/**
 * Gateway-backed `WorldOperations`: forwards the agent-side world tool's read
 * and control calls to the privileged Satellite-Hub-backed gateway methods.
 * The gateway holds the Hub control credential; this class only
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
    // 2h6q.3: stamp server-side lineage from the runtime request context so a
    // shard-session world-control call reaches the gateway on its shard
    // channel. The stamp comes from the agent runtime's AsyncLocalStorage
    // turn correlation (the LLM/tool layer cannot set it), and the gateway
    // uses it only as a lookup key into server-owned workload registration
    // state — never as authority.
    const contextChannelId = getRequestContext()?.channelId?.trim();
    return this.homeAssistant.callService({
      ...params,
      ...(contextChannelId ? { channelId: contextChannelId } : {}),
    });
  }
}
