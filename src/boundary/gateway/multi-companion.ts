// ── Gateway multi-companion routing config (sprint-10 W1) ──
// One gateway, N agent processes: every inbound channel surface must resolve
// to exactly one companion, and every gateway↔agent exchange must stay bound
// to the companion connection that originated it. Routing here is fail-closed:
// any ambiguity is an error, never a broadcast or a first-ready fallback.

import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';

/** Gateway-facing channel surfaces that can be routed to a companion. */
export const GATEWAY_CHANNEL_SURFACES = ['discord', 'telegram', 'api', 'multica', 'buzz'] as const;
export type GatewayChannelSurface = (typeof GATEWAY_CHANNEL_SURFACES)[number];

export type AuthenticatedGatewayAccountRoute =
  | { kind: 'discord'; accountId: string }
  | { kind: 'plugin'; pluginId: string; accountId: string };

export interface GatewayCompanionRouteViolation {
  code: 'unrouted_channel' | 'unrouted_discord_account' | 'unrouted_plugin_account';
  message: string;
  details: Readonly<Record<string, unknown>>;
  errorMessage: string;
}

export interface GatewayMultiCompanionConfig {
  enabled: boolean;
  /** companions.json-owned identities accepted at the RPC authentication boundary. */
  fleetCompanionIds: readonly CompanionId[];
  /** channels.json-owned surface→companionId routing table. */
  channelRouting: Partial<Record<GatewayChannelSurface, CompanionId>>;
  /**
   * Multi-account discord routing (W1-P2): accountId → companionId, one bot
   * identity per companion. Mutually exclusive with `channelRouting.discord`
   * (enforced by the channels.json parser).
   */
  discordAccounts: Record<string, CompanionId>;
  /** Plugin id -> account id -> companion id, derived only from parsed plugin instances. */
  pluginAccounts: Partial<Record<GatewayChannelSurface, Record<string, CompanionId>>>;
  /** Canonical Personal Workspace root for every fleet companion. */
  personalWorkspaceByCompanionId: Readonly<Record<string, string>>;
  /** Governed installation-shared workspace; never used as a personal root. */
  sharedWorkspacePath?: string;
}

export function disabledGatewayMultiCompanionConfig(): GatewayMultiCompanionConfig {
  return {
    enabled: false,
    fleetCompanionIds: [],
    channelRouting: {},
    discordAccounts: {},
    pluginAccounts: {},
    personalWorkspaceByCompanionId: {},
  };
}

function pluginChannelRouting(
  channelsConfig: RuntimeChannelsConfig,
): Partial<Record<GatewayChannelSurface, CompanionId>> {
  const routing: Partial<Record<GatewayChannelSurface, CompanionId>> = {};
  for (const section of Object.values(channelsConfig.plugins)) {
    if (!section.enabled || !section.companionId) continue;
    routing[section.id as GatewayChannelSurface] = section.companionId;
  }
  return routing;
}

function pluginAccountRouting(
  channelsConfig: RuntimeChannelsConfig,
): Partial<Record<GatewayChannelSurface, Record<string, CompanionId>>> {
  const routing: Partial<Record<GatewayChannelSurface, Record<string, CompanionId>>> = {};
  for (const section of Object.values(channelsConfig.plugins)) {
    if (!section.enabled || !section.instances || section.instances.length === 0) continue;
    if (!GATEWAY_CHANNEL_SURFACES.includes(section.id as GatewayChannelSurface)) {
      throw new Error(`Channel plugin ${JSON.stringify(section.id)} has no gateway routing surface`);
    }
    const accounts: Record<string, CompanionId> = {};
    for (const instance of section.instances) {
      if (!instance.companionId) {
        throw new Error(
          `Channel plugin ${JSON.stringify(section.id)} account ${JSON.stringify(instance.id)} `
          + 'is missing companionId routing',
        );
      }
      if (Object.hasOwn(accounts, instance.id)) {
        throw new Error(
          `Channel plugin ${JSON.stringify(section.id)} has duplicate account ${JSON.stringify(instance.id)}`,
        );
      }
      accounts[instance.id] = instance.companionId;
    }
    routing[section.id as GatewayChannelSurface] = accounts;
  }
  return routing;
}

/**
 * Maps an inbound message channel type onto a routable gateway surface.
 * Returns null for channel types that have no multi-companion routing lane —
 * callers must fail closed on null when multi-companion is active.
 */
export function resolveGatewaySurfaceForChannelType(
  channelType: ChannelType,
): GatewayChannelSurface | null {
  switch (channelType) {
    case 'discord':
      return 'discord';
    case 'telegram':
      return 'telegram';
    case 'api':
      return 'api';
    case 'multica':
      return 'multica';
    case 'buzz':
      return 'buzz';
    default:
      return null;
  }
}

/** Resolve one authenticated channel route without any connection or alarm side effects. */
export function resolveConfiguredGatewayCompanion(
  config: GatewayMultiCompanionConfig,
  surface: GatewayChannelSurface,
  route: AuthenticatedGatewayAccountRoute | undefined,
  reject: (violation: GatewayCompanionRouteViolation) => never,
): CompanionId {
  if (surface === 'discord' && Object.keys(config.discordAccounts).length > 0) {
    if (route?.kind !== 'discord') {
      return reject({
        code: route?.kind === 'plugin' ? 'unrouted_plugin_account' : 'unrouted_discord_account',
        message: route?.kind === 'plugin'
          ? `Channel plugin "${route.pluginId}" cannot route a discord message`
          : 'Discord surface uses per-account routing but the inbound message carries no accountId',
        details: { surface, ...(route?.kind === 'plugin' ? { pluginId: route.pluginId } : {}) },
        errorMessage: route?.kind === 'plugin'
          ? `Channel plugin "${route.pluginId}" cannot route channel surface "discord"`
          : 'Multi-account discord routing requires an accountId for the discord surface',
      });
    }
    const companionId = config.discordAccounts[route.accountId];
    if (!companionId) {
      return reject({
        code: 'unrouted_discord_account',
        message: `Discord account "${route.accountId}" has no companion routing entry in channels.json`,
        details: { surface, discordAccountId: route.accountId },
        errorMessage: `Multi-companion routing has no companion for discord account "${route.accountId}"`,
      });
    }
    return companionId;
  }

  const pluginAccounts = config.pluginAccounts[surface];
  if (pluginAccounts && Object.keys(pluginAccounts).length > 0) {
    if (route?.kind !== 'plugin') {
      return reject({
        code: 'unrouted_plugin_account',
        message: `Channel plugin "${surface}" uses per-account routing but the inbound request carries no account route`,
        details: { surface },
        errorMessage: `Multi-account ${surface} routing requires an account route`,
      });
    }
    if (route.pluginId !== surface) {
      return reject({
        code: 'unrouted_plugin_account',
        message: `Channel plugin "${route.pluginId}" cannot route a ${surface} message`,
        details: { surface, pluginId: route.pluginId, accountId: route.accountId },
        errorMessage: `Channel plugin "${route.pluginId}" cannot route channel surface "${surface}"`,
      });
    }
    const companionId = pluginAccounts[route.accountId];
    if (!companionId) {
      return reject({
        code: 'unrouted_plugin_account',
        message: `Channel plugin "${surface}" account "${route.accountId}" has no companion routing entry`,
        details: { surface, accountId: route.accountId },
        errorMessage: `Multi-companion routing has no companion for ${surface} account "${route.accountId}"`,
      });
    }
    return companionId;
  }

  if (route) {
    const pluginRoute = route.kind === 'plugin';
    return reject({
      code: pluginRoute ? 'unrouted_plugin_account' : 'unrouted_discord_account',
      message: pluginRoute
        ? `Received ${surface} route for plugin "${route.pluginId}" account "${route.accountId}" but no plugin account routing is configured`
        : `Received discord accountId "${route.accountId}" but no discord.accounts routing is configured`,
      details: pluginRoute
        ? { surface, pluginId: route.pluginId, accountId: route.accountId }
        : { surface, discordAccountId: route.accountId },
      errorMessage: pluginRoute
        ? `No ${surface} account routing configured for plugin "${route.pluginId}" account "${route.accountId}"`
        : `No discord account routing configured for account "${route.accountId}"`,
    });
  }

  const companionId = config.channelRouting[surface];
  if (!companionId) {
    return reject({
      code: 'unrouted_channel',
      message: `Channel surface "${surface}" has no companion routing entry in channels.json`,
      details: { surface },
      errorMessage: `Multi-companion routing has no companion for channel surface "${surface}"`,
    });
  }
  return companionId;
}

/**
 * Build the gateway's multi-companion routing config.
 *
 * The topology authority is the canonical config resolution: `loadConfig()`
 * projects the mandatory companions.json manifest onto `config.companionFleet`.
 * A one-entry roster uses the same authenticated, companion-bound gateway path
 * as a larger roster; only peer-to-peer behaviors depend on `multiCompanion`.
 * This module derives the gateway's surface→companion routing table from
 * channels.json on top of that topology.
 */
export function resolveGatewayMultiCompanionConfig(
  config: Pick<SubstrateConfig, 'multiCompanion' | 'companionFleet' | 'fleetAuth'>,
  channelsConfig: RuntimeChannelsConfig,
  satelliteRegistryConfig: SatelliteRegistryConfig,
): GatewayMultiCompanionConfig {
  const fleetCompanionIds = config.companionFleet?.companions.map(entry => entry.companionId) ?? [];
  const enabled = config.companionFleet !== undefined
    || config.multiCompanion === true
    || config.fleetAuth !== undefined;
  if (enabled && fleetCompanionIds.length === 0) {
    throw new Error('Fleet gateway routing requires a non-empty resolved companions.json fleet');
  }
  const fleetIds = new Set<CompanionId>(fleetCompanionIds);
  const personalWorkspaceByCompanionId = Object.fromEntries(
    (config.companionFleet?.companions ?? []).map(entry => [
      entry.companionId,
      entry.personalWorkspacePath,
    ]),
  );

  const soleCompanionId = fleetCompanionIds.length === 1 ? fleetCompanionIds[0] : undefined;
  const channelRouting: Partial<Record<GatewayChannelSurface, CompanionId>> = {
    ...(channelsConfig.discord.companionId ?? soleCompanionId
      ? { discord: channelsConfig.discord.companionId ?? soleCompanionId }
      : {}),
    ...(channelsConfig.telegram.companionId ?? soleCompanionId
      ? { telegram: channelsConfig.telegram.companionId ?? soleCompanionId }
      : {}),
    ...(channelsConfig.api.companionId ?? soleCompanionId
      ? { api: channelsConfig.api.companionId ?? soleCompanionId }
      : {}),
    ...pluginChannelRouting(channelsConfig),
  };

  const discordAccounts: Record<string, CompanionId> = {};
  for (const account of channelsConfig.discord.accounts ?? []) {
    discordAccounts[account.accountId] = account.companionId;
  }
  const pluginAccounts = pluginAccountRouting(channelsConfig);

  const routedSurfaces = Object.keys(channelRouting);
  if (!enabled && routedSurfaces.length > 0) {
    throw new Error(
      `channels.json declares companionId routing for [${routedSurfaces.join(', ')}] but this is a `
      + 'single-companion (one-entry companions.json) deployment. Add the companion to companions.json '
      + 'or remove the companionId fields — single-companion mode must not silently ignore routing config.',
    );
  }
  const routedAccountIds = Object.keys(discordAccounts);
  if (!enabled && routedAccountIds.length > 0) {
    throw new Error(
      `channels.json declares discord.accounts [${routedAccountIds.join(', ')}] but this is a `
      + 'single-companion (one-entry companions.json) deployment. Add the companions to companions.json '
      + 'or remove the accounts section — single-companion mode must not silently ignore per-companion bot identities.',
    );
  }
  const routedPluginAccountIds = Object.entries(pluginAccounts)
    .flatMap(([pluginId, accounts]) => Object.keys(accounts).map(accountId => `${pluginId}:${accountId}`));
  if (!enabled && routedPluginAccountIds.length > 0) {
    throw new Error(
      `channels.json declares plugin accounts [${routedPluginAccountIds.join(', ')}] but this is a `
      + 'single-companion (one-entry companions.json) deployment. Add the companions to companions.json '
      + 'or remove the plugin accounts — single-companion mode must not silently ignore per-companion identities.',
    );
  }

  const sharedSatellites = satelliteRegistryConfig.satellites.filter(
    satellite => satellite.sharedDevice !== undefined,
  );
  if (!enabled && sharedSatellites.length > 0) {
    throw new Error(
      `satellites.json declares shared-device routing for [${sharedSatellites
        .map(satellite => satellite.satelliteId)
        .join(', ')}] but this is a single-companion (one-entry companions.json) deployment. Add the `
      + 'companions to companions.json or remove the sharedDevice declarations — single-companion '
      + 'mode must not silently ignore shared-device authority.',
    );
  }

  if (enabled) {
    const ungovernedSatelliteIds = satelliteRegistryConfig.satellites
      .filter(satellite => satellite.sharedDevice === undefined)
      .map(satellite => satellite.satelliteId);
    if (satelliteRegistryConfig.enabled && ungovernedSatelliteIds.length > 0) {
      throw new Error(
        `Multi-companion satellites.json requires sharedDevice authority for [${ungovernedSatelliteIds
          .join(', ')}]`,
      );
    }
    for (const [surface, companionId] of Object.entries(channelRouting)) {
      if (!fleetIds.has(companionId)) {
        throw new Error(
          `channels.json routes ${surface} to companionId ${JSON.stringify(companionId)}, `
          + 'which is absent from companions.json',
        );
      }
    }
    for (const [accountId, companionId] of Object.entries(discordAccounts)) {
      if (!fleetIds.has(companionId)) {
        throw new Error(
          `channels.json routes discord account ${JSON.stringify(accountId)} to companionId `
          + `${JSON.stringify(companionId)}, which is absent from companions.json`,
        );
      }
    }
    for (const [pluginId, accounts] of Object.entries(pluginAccounts)) {
      for (const [accountId, companionId] of Object.entries(accounts)) {
        if (fleetIds.has(companionId)) continue;
        throw new Error(
          `channels.json routes ${pluginId} account ${JSON.stringify(accountId)} to companionId `
          + `${JSON.stringify(companionId)}, which is absent from companions.json`,
        );
      }
    }
    if (satelliteRegistryConfig.productivityCompanionId
      && !fleetIds.has(satelliteRegistryConfig.productivityCompanionId)) {
      throw new Error(
        'satellites.json productivityCompanionId is absent from companions.json',
      );
    }
    for (const satellite of sharedSatellites) {
      const policy = satellite.sharedDevice!;
      const governedCompanionIds = new Set([
        policy.primaryCompanionId,
        ...policy.emanationMemberIds,
        ...policy.observationRecipients.map(recipient => recipient.companionId),
      ]);
      for (const companionId of governedCompanionIds) {
        if (fleetIds.has(companionId)) continue;
        throw new Error(
          `satellites.json shared device ${JSON.stringify(satellite.satelliteId)} names companionId `
          + `${JSON.stringify(companionId)}, which is absent from companions.json`,
        );
      }
    }
  }

  return {
    enabled,
    fleetCompanionIds,
    channelRouting,
    discordAccounts,
    pluginAccounts,
    personalWorkspaceByCompanionId,
    ...(config.companionFleet?.sharedWorkspacePath
      ? { sharedWorkspacePath: config.companionFleet.sharedWorkspacePath }
      : {}),
  };
}
