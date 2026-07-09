// ── Gateway multi-companion routing config (sprint-10 W1) ──
// One gateway, N agent processes: every inbound channel surface must resolve
// to exactly one companion, and every gateway↔agent exchange must stay bound
// to the companion connection that originated it. Routing here is fail-closed:
// any ambiguity is an error, never a broadcast or a first-ready fallback.

import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { MULTI_COMPANION_ENV_VAR } from '../../system/config/companions-config.js';

/** Gateway-facing channel surfaces that can be routed to a companion. */
export const GATEWAY_CHANNEL_SURFACES = ['discord', 'telegram', 'api'] as const;
export type GatewayChannelSurface = (typeof GATEWAY_CHANNEL_SURFACES)[number];

export interface GatewayMultiCompanionConfig {
  enabled: boolean;
  /** companions.json-owned identities accepted at the RPC authentication boundary. */
  fleetCompanionIds: readonly string[];
  /** channels.json-owned surface→companionId routing table. */
  channelRouting: Partial<Record<GatewayChannelSurface, string>>;
  /**
   * Multi-account discord routing (W1-P2): accountId → companionId, one bot
   * identity per companion. Mutually exclusive with `channelRouting.discord`
   * (enforced by the channels.json parser).
   */
  discordAccounts: Record<string, string>;
}

export function disabledGatewayMultiCompanionConfig(): GatewayMultiCompanionConfig {
  return { enabled: false, fleetCompanionIds: [], channelRouting: {}, discordAccounts: {} };
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
 * The flag authority is the canonical config resolution: `loadConfig()` sets
 * `config.multiCompanion` via `isMultiCompanionEnabled` (companions-config.ts,
 * the `PSFN_MULTI_COMPANION` / companions.json owner-file surface from the
 * config-scoping workstream). This module only derives the gateway's
 * surface→companion routing table from channels.json on top of that flag.
 */
export function resolveGatewayMultiCompanionConfig(
  config: Pick<SubstrateConfig, 'multiCompanion' | 'companionFleet'>,
  channelsConfig: RuntimeChannelsConfig,
): GatewayMultiCompanionConfig {
  const enabled = config.multiCompanion === true;
  const fleetCompanionIds = config.companionFleet?.companions.map(entry => entry.companionId) ?? [];
  if (enabled && fleetCompanionIds.length === 0) {
    throw new Error('Multi-companion gateway routing requires a non-empty resolved companions.json fleet');
  }
  const fleetIds = new Set(fleetCompanionIds);

  const channelRouting: Partial<Record<GatewayChannelSurface, string>> = {
    ...(channelsConfig.discord.companionId ? { discord: channelsConfig.discord.companionId } : {}),
    ...(channelsConfig.telegram.companionId ? { telegram: channelsConfig.telegram.companionId } : {}),
    ...(channelsConfig.api.companionId ? { api: channelsConfig.api.companionId } : {}),
  };

  const discordAccounts: Record<string, string> = {};
  for (const account of channelsConfig.discord.accounts ?? []) {
    discordAccounts[account.accountId] = account.companionId;
  }

  const routedSurfaces = Object.keys(channelRouting);
  if (!enabled && routedSurfaces.length > 0) {
    throw new Error(
      `channels.json declares companionId routing for [${routedSurfaces.join(', ')}] but `
      + `${MULTI_COMPANION_ENV_VAR} is not enabled. Enable the flag or remove the companionId `
      + 'fields — single-companion mode must not silently ignore routing config.',
    );
  }
  const routedAccountIds = Object.keys(discordAccounts);
  if (!enabled && routedAccountIds.length > 0) {
    throw new Error(
      `channels.json declares discord.accounts [${routedAccountIds.join(', ')}] but `
      + `${MULTI_COMPANION_ENV_VAR} is not enabled. Enable the flag or remove the accounts `
      + 'section — single-companion mode must not silently ignore per-companion bot identities.',
    );
  }

  if (enabled) {
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
  }

  return { enabled, fleetCompanionIds, channelRouting, discordAccounts };
}
