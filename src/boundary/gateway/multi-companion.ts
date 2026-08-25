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
export const GATEWAY_CHANNEL_SURFACES = ['discord', 'telegram', 'api'] as const;
export type GatewayChannelSurface = (typeof GATEWAY_CHANNEL_SURFACES)[number];

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
    personalWorkspaceByCompanionId: {},
  };
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
    default:
      return null;
  }
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
  };

  const discordAccounts: Record<string, CompanionId> = {};
  for (const account of channelsConfig.discord.accounts ?? []) {
    discordAccounts[account.accountId] = account.companionId;
  }

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
    personalWorkspaceByCompanionId,
    ...(config.companionFleet?.sharedWorkspacePath
      ? { sharedWorkspacePath: config.companionFleet.sharedWorkspacePath }
      : {}),
  };
}
