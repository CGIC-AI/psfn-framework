import type {
  GatewayOpsPort,
  HomeAssistantOperations,
  WorldAvatarOperations,
} from '../../gateway/gateway-ops-port.js';
import type {
  HomeAssistantCallServiceResult,
  HomeAssistantGetStatesResult,
  WorldAvatarActParams,
  WorldAvatarActResult,
  WorldAvatarMapParams,
  WorldAvatarMapResult,
  WorldAvatarSnapshotParams,
  WorldAvatarSnapshotResult,
  WorldAvatarMoveParams,
  WorldAvatarMoveResult,
  WorldAvatarPerceiveParams,
  WorldAvatarPerceiveResult,
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
  private readonly worldAvatar: WorldAvatarOperations | undefined;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'homeAssistant' | 'worldAvatar'> | HomeAssistantOperations) {
    this.homeAssistant = 'homeAssistant' in gatewayOps ? gatewayOps.homeAssistant : gatewayOps;
    this.worldAvatar = 'homeAssistant' in gatewayOps ? gatewayOps.worldAvatar : undefined;
  }

  async avatarPerceive(params: WorldAvatarPerceiveParams = {}): Promise<WorldAvatarPerceiveResult> {
    return this.requireAvatar().perceive({ ...params, ...this.correlation() });
  }

  async avatarMap(params: WorldAvatarMapParams = {}): Promise<WorldAvatarMapResult> {
    return this.requireAvatar().map({ ...params, ...this.correlation() });
  }

  async avatarSnapshot(params: WorldAvatarSnapshotParams = {}): Promise<WorldAvatarSnapshotResult> {
    return this.requireAvatar().snapshot({ ...params, ...this.correlation() });
  }

  async avatarMove(params: WorldAvatarMoveParams): Promise<WorldAvatarMoveResult> {
    return this.requireAvatar().move({ ...params, ...this.correlation() });
  }

  async avatarAct(params: WorldAvatarActParams): Promise<WorldAvatarActResult> {
    return this.requireAvatar().act({ ...params, ...this.correlation() });
  }

  private requireAvatar(): WorldAvatarOperations {
    if (!this.worldAvatar) throw new Error('world avatar operations are not wired in this runtime');
    return this.worldAvatar;
  }

  private correlation(): { channelId?: string } {
    const contextChannelId = getRequestContext()?.channelId?.trim();
    return contextChannelId ? { channelId: contextChannelId } : {};
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
