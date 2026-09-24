// Per-connection resource scope derived only from the connection's bound
// companion identity (never from parameters): Personal Workspace path, the
// companion-scoped policy config, governed shared-workspace reads, and the
// outbound Discord / channel-plugin docks a companion may egress through.
import { isRecord } from '../../../shared/utils/types.js';
import type { ChannelOutboundDock } from '../../../channels/backplane/types.js';
import { resolvePersonalSkillsDir } from '../../../persistence/layout.js';
import type { SharedCompanionWorkspaceReader } from '../../../persistence/workspaces/shared-workspace-reader.js';
import type { PolicyConfig } from '../policy.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayServerPorts } from './ports.js';

export class GatewayConnectionScope {
  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'options'
      | 'multiCompanion'
      | 'connectionStatuses'
      | 'sharedWorkspaceReader'
      | 'discordAccountRoutingActive'
      | 'alarmCompanionViolation'
    >,
  ) {}

  private requireSharedWorkspaceReader(conn: GatewayRpcConnection): SharedCompanionWorkspaceReader {
    const status = this.ports.connectionStatuses.get(conn);
    if (!this.ports.multiCompanion.enabled
      || status?.role !== 'agent'
      || !status.companionId
      || !this.ports.sharedWorkspaceReader) {
      throw new Error('Shared workspace reads require an authenticated fleet companion connection');
    }
    return this.ports.sharedWorkspaceReader;
  }

  async listSharedWorkspaceArtifacts(conn: GatewayRpcConnection, params: unknown) {
    // A continuation cursor is the only accepted parameter. Page size stays
    // operator policy, so a caller can neither raise nor lower it, and any
    // other key is still an identity assertion attempt.
    const keys = isRecord(params) ? Object.keys(params) : [];
    const cursor = isRecord(params) ? params.cursor : undefined;
    if (params !== undefined
      && (!isRecord(params)
        || keys.some(key => key !== 'cursor')
        || (cursor !== undefined && typeof cursor !== 'string'))) {
      throw new Error('shared.workspace.list accepts no parameters or identity assertions');
    }
    const bounds = this.ports.options.sharedWorkspaceListBounds;
    if (!bounds) {
      throw new Error('Shared workspace listing has no operator-declared bounds');
    }
    const reader = this.requireSharedWorkspaceReader(conn);
    const page = reader.listArtifacts({
      bounds,
      ...(typeof cursor === 'string' ? { cursor } : {}),
    });
    return { artifacts: page.artifacts, nextCursor: page.nextCursor };
  }

  async readSharedWorkspaceArtifact(conn: GatewayRpcConnection, params: unknown) {
    if (!isRecord(params)
      || Object.keys(params).length !== 1
      || typeof params.artifactPath !== 'string') {
      throw new Error('shared.workspace.read requires only artifactPath; identity assertions are forbidden');
    }
    return this.requireSharedWorkspaceReader(conn).readArtifact(params.artifactPath);
  }

  resolveConnectionWorkspacePath(conn: GatewayRpcConnection): string {
    if (!this.ports.multiCompanion.enabled) {
      return this.ports.options.policyConfig.workspacePath;
    }
    const companionId = this.ports.connectionStatuses.get(conn)?.companionId;
    if (!companionId) {
      throw new Error('Multi-companion workspace access requires an authenticated companion connection');
    }
    const workspacePath = this.ports.multiCompanion.personalWorkspaceByCompanionId[companionId];
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      throw new Error(`No Personal Workspace is resolved for companion ${companionId}`);
    }
    return workspacePath;
  }

  resolveConnectionPolicyConfig(conn: GatewayRpcConnection): PolicyConfig {
    if (!this.ports.multiCompanion.enabled) {
      return this.ports.options.policyConfig;
    }
    // Method registration inspects policy feature flags before the connection
    // can authenticate. Request dispatch still rejects every non-identify RPC
    // from an unidentified connection; return the base config only for that
    // registration phase and bind the personal policy after identify.
    if (!this.ports.connectionStatuses.get(conn)?.companionId) {
      return this.ports.options.policyConfig;
    }
    const workspacePath = this.resolveConnectionWorkspacePath(conn);
    const { fullCodebaseReadRoot: _ignoredReadRoot, ...basePolicy } = this.ports.options.policyConfig;
    return {
      ...basePolicy,
      workspacePath,
      allowedReadPaths: [workspacePath],
      protectedWritePaths: [
        ...(basePolicy.protectedWritePaths ?? []),
        resolvePersonalSkillsDir(workspacePath),
      ],
      ...(basePolicy.shellExec
        ? { shellExec: { ...basePolicy.shellExec, allowedCwd: [workspacePath] } }
        : {}),
    };
  }

  /**
   * Outbound discord dock for one agent connection. Single-companion mode and
   * W1 single-account multi-companion mode keep today's shared adapter
   * byte-identical; multi-account mode resolves the calling companion's own
   * bot account at send time and fails closed (alarm + error) when the
   * connection is unidentified or its companion owns no discord account —
   * cross-account egress is structurally impossible because the dock is
   * derived from the connection's bound companionId, never from parameters.
   */
  resolveConnectionDiscordDock(conn: GatewayRpcConnection): ChannelOutboundDock {
    if (!this.ports.discordAccountRoutingActive()) {
      return this.ports.options.discordAdapter;
    }
    const requireDock = (): ChannelOutboundDock => this.requireCompanionDiscordDock(conn);
    return {
      id: 'discord',
      outbound: {
        textChunkLimit: this.ports.options.discordAdapter.outbound.textChunkLimit,
        sendText: async (ctx, text) => {
          await requireDock().outbound.sendText(ctx, text);
        },
        sendMedia: async (ctx, media) => {
          const dock = requireDock();
          if (!dock.outbound.sendMedia) {
            throw new Error('Discord outbound dock does not support media sends');
          }
          await dock.outbound.sendMedia(ctx, media);
        },
      },
      availability: {
        setAvailability: async state => {
          const dock = requireDock();
          return dock.availability
            ? dock.availability.setAvailability(state)
            : 'unsupported';
        },
      },
    };
  }

  private requireCompanionDiscordDock(conn: GatewayRpcConnection): ChannelOutboundDock {
    const companionId = this.ports.connectionStatuses.get(conn)?.companionId;
    if (!companionId) {
      this.ports.alarmCompanionViolation(
        'discord_send_unidentified',
        'Discord outbound rejected: connection has no bound companionId',
        {},
      );
      throw new Error('Multi-account discord outbound requires an identified companion connection');
    }
    const dock = this.ports.options.discordAccountDocks?.get(companionId);
    if (!dock) {
      this.ports.alarmCompanionViolation(
        'discord_send_no_account',
        `Discord outbound rejected: companion "${companionId}" owns no discord bot account`,
        { companionId },
      );
      throw new Error(
        `Companion "${companionId}" has no discord bot account; sending through another `
        + 'companion\'s account is not permitted',
      );
    }
    return dock;
  }

  resolveConnectionPluginOutboundDock(
    conn: GatewayRpcConnection,
    pluginId: 'buzz',
  ): ChannelOutboundDock {
    const routes = this.ports.options.pluginOutboundRoutes ?? [];
    const companionId = this.ports.connectionStatuses.get(conn)?.companionId;
    const ownedRoutes = this.ports.multiCompanion.enabled
      ? routes.filter(route => route.companionId === companionId)
      : routes;
    if (this.ports.multiCompanion.enabled && !companionId) {
      this.ports.alarmCompanionViolation(
        'channel_send_unidentified',
        `${pluginId} outbound rejected: connection has no bound companionId`,
        { pluginId },
      );
      throw new Error(`${pluginId} outbound requires an identified companion connection`);
    }
    if (ownedRoutes.length !== 1) {
      this.ports.alarmCompanionViolation(
        'channel_send_no_account',
        `${pluginId} outbound rejected: caller does not own exactly one account`,
        { pluginId, ...(companionId ? { companionId } : {}), accountCount: ownedRoutes.length },
      );
      throw new Error(
        companionId
          ? `Companion "${companionId}" does not own exactly one ${pluginId} account`
          : `${pluginId} outbound requires exactly one configured account`,
      );
    }
    return ownedRoutes[0]!.dock;
  }
}
