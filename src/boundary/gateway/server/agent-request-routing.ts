// Gateway -> agent reverse-RPC request routing: API-surface requests, exact
// companion authority reads, turn-performance forwarding, and inbound voice
// streams. Single-companion mode targets the first ready agent; multi-companion
// mode routes fail-closed to the owning companion. Replies are canary-scanned
// before they reach any channel surface.
import { isRecord } from '../../../shared/utils/types.js';
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { ChannelPluginAccountRoute } from '../../../channels/plugins/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import type { TurnPerformanceEvent } from '../../../shared/telemetry/turn-performance.js';
import { resolveGatewaySurfaceForChannelType } from '../multi-companion.js';
import type { VoiceHandleMessageResult } from '../protocol.js';
import type { GatewayRpcConnection } from '../transport.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from '../voice-stream-request.js';
import { materializeGatewayAttachments } from '../attachment-materialization.js';
import type { GatewayServerCollaboratorPorts } from './collaborator-ports.js';
import type { GatewayConnectionRouter } from './connection-routing.js';
import type { GatewayServerPorts } from './ports.js';

export class GatewayAgentRequests {
  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'options'
      | 'multiCompanion'
      | 'companionConnections'
      | 'connectionStatuses'
      | 'rpcClients'
      | 'wyomingShardRouting'
      | 'nextStreamRequestCounter'
      | 'alarmCompanionViolation'
      | 'refreshConnectionHealth'
    > & Pick<
      GatewayServerCollaboratorPorts,
      'auditTrail' | 'connectionRouter' | 'connectionScope' | 'sharedSatellite'
    >,
  ) {}

  /** Local readiness of the same owner used by API requests, without sending RPC. */
  isApiReady(): boolean {
    try {
      if (this.ports.multiCompanion.enabled) this.ports.connectionRouter.resolveCompanionAgent('api');
      else this.ports.connectionRouter.resolveReadyAgentConnection();
      return true;
    } catch {
      // Route resolution rejects absent, unready, stale, or unbound owners.
      return false;
    }
  }

  /**
   * Send an RPC request to the agent and await its response. This is the
   * gateway API-surface request path (api.chat.completion, api.health, …):
   * single-companion mode targets the first ready agent (unchanged); under
   * multi-companion it routes fail-closed to the companion that owns the
   * `api` channel surface.
   */
  async requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const client = this.ports.multiCompanion.enabled
      ? this.ports.connectionRouter.resolveCompanionAgent('api').client
      : this.ports.connectionRouter.resolveReadyRpcClient();

    const result = await Promise.race([
      client.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent request timed out')), timeoutMs),
      ),
    ]);
    // d269: reverse-RPC results are reply egress — scan before returning to
    // any channel surface.
    return await this.ports.auditTrail.inspectAgentReply(method, result) as T;
  }

  /** Route one exact authority read to the authenticated companion agent. */
  async requestCompanionAgent<T = unknown>(
    companionId: string,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const exactCompanionId = createCompanionId(
      companionId,
      'Explicit companion agent request companionId',
    );
    const client = this.ports.multiCompanion.enabled
      ? this.ports.connectionRouter.requireReadyCompanionRoute('api', exactCompanionId).client
      : this.ports.connectionRouter.resolveReadyRpcClient();
    const result = await Promise.race([
      client.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Companion agent request timed out')), timeoutMs),
      ),
    ]);
    // d269: reverse-RPC results are reply egress — scan before returning to
    // any channel surface.
    return await this.ports.auditTrail.inspectAgentReply(method, result) as T;
  }

  /**
   * Forward a gateway-process timing observation to the owning agent process,
   * where the canonical Garden tracker lives. Multi-companion routing requires
   * an explicit event companionId and never falls back to another agent.
   */
  async requestAgentTurnPerformance(
    event: TurnPerformanceEvent,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<void> {
    let client: JSONRPCServerAndClient;
    if (this.ports.multiCompanion.enabled) {
      if (!event.companionId) {
        throw new Error('Multi-companion turn performance forwarding requires event.companionId');
      }
      const companionId = createCompanionId(event.companionId, 'Turn performance companionId');
      this.ports.refreshConnectionHealth();
      const conn = this.ports.companionConnections.get(companionId);
      const status = conn ? this.ports.connectionStatuses.get(conn) : undefined;
      if (!conn
        || !status
        || status.role !== 'agent'
        || status.state !== 'ready'
        || status.health !== 'healthy') {
        throw new Error(`No ready agent connection for turn performance companion "${companionId}"`);
      }
      const routedClient = this.ports.rpcClients.get(conn);
      if (!routedClient) {
        throw new Error(`No RPC client for turn performance companion "${companionId}"`);
      }
      client = routedClient;
    } else {
      client = this.ports.connectionRouter.resolveReadyRpcClient();
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Turn performance forwarding timed out')),
        timeoutMs,
      );
      timeoutHandle.unref();
    });
    let result: unknown;
    try {
      result = await Promise.race([
        client.request('telemetry.turn.performance', { event }),
        timeout,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (!isRecord(result)
      || result.accepted !== true
      || Object.keys(result).some(key => key !== 'accepted')) {
      throw new Error('Agent rejected turn performance telemetry');
    }
  }

  async requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions & {
      channelAccountRoute?: ChannelPluginAccountRoute;
    } = {},
  ): Promise<VoiceHandleMessageResult> {
    const { channelAccountRoute, ...voiceOptions } = options;
    const sharedSatellite = this.ports.multiCompanion.enabled
      && message.routing?.source === 'satellite'
      ? message.routing.satellite
      : undefined;
    if (channelAccountRoute && message.routing?.source === 'satellite') {
      this.ports.alarmCompanionViolation(
        'invalid_satellite_route',
        `Channel plugin "${channelAccountRoute.pluginId}" cannot supply satellite routing metadata`,
        { channelType: message.channelType, pluginId: channelAccountRoute.pluginId },
      );
      throw new Error('Channel plugin account routes cannot select a satellite companion');
    }
    if (sharedSatellite?.sharedDevice) {
      return await this.ports.sharedSatellite.requestSharedSatelliteVoiceStream(
        message,
        { ...sharedSatellite, sharedDevice: sharedSatellite.sharedDevice },
        voiceOptions,
      );
    }
    let client: JSONRPCServerAndClient;
    let conn: GatewayRpcConnection;
    let companionId = this.ports.options.companionId;
    if (this.ports.multiCompanion.enabled) {
      const satellite = message.routing?.satellite;
      const satelliteSource = message.routing?.source === 'satellite';
      let route: ReturnType<GatewayConnectionRouter['resolveCompanionAgent']>;
      if (satellite) {
        if (!satelliteSource) {
          this.ports.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound voice message carries satellite metadata without a satellite routing source',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing metadata requires routing.source="satellite"');
        }
        route = this.ports.connectionRouter.resolveSatelliteCompanionAgent(satellite);
      } else {
        if (satelliteSource) {
          this.ports.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound satellite voice message is missing authenticated satellite routing metadata',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing requires authenticated satellite metadata');
        }
        const surface = resolveGatewaySurfaceForChannelType(message.channelType);
        if (!surface) {
          this.ports.alarmCompanionViolation(
            'unrouted_channel',
            `Inbound message channelType "${message.channelType}" has no multi-companion routing surface`,
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error(
            `Multi-companion routing cannot map channelType "${message.channelType}" to a companion`,
          );
        }
        route = this.ports.connectionRouter.resolveCompanionAgent(
          surface,
          channelAccountRoute
            ? { kind: 'plugin', ...channelAccountRoute }
            : undefined,
        );
      }
      client = route.client;
      conn = route.conn;
      companionId = route.companionId;
    } else {
      const route = this.ports.connectionRouter.resolveReadyAgentConnection();
      client = route.client;
      conn = route.conn;
      companionId ??= this.ports.connectionStatuses.get(conn)?.companionId;
    }
    if (!companionId) {
      throw new Error(
        'Gateway voice routing requires a lowercase RFC-4122 companion UUID binding',
      );
    }

    const screenedMessage = voiceOptions.screenMessageForCompanion
      ? await voiceOptions.screenMessageForCompanion(message, companionId)
      : message;
    const result = await requestAgentVoiceStream({
      client,
      message: screenedMessage,
      options: voiceOptions,
      wyomingShardRouting: this.ports.wyomingShardRouting,
      companionId,
      nextRequestCounter: () => this.ports.nextStreamRequestCounter(),
      // d269: main-reply canary scan at the reverse-RPC seam.
      inspectReply: (replyMethod, replyResult) => this.ports.auditTrail.inspectAgentReply(replyMethod, replyResult),
    });
    const attachments = materializeGatewayAttachments(
      result.attachments,
      this.ports.connectionScope.resolveConnectionWorkspacePath(conn),
    );
    return { ...result, ...(attachments ? { attachments } : {}) };
  }
}
