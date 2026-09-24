// Construction-time topology validation for GatewayServer. Every check fails
// the gateway at boot (throws) rather than degrading at the first request:
// single- vs multi-companion lanes, governed shared-workspace bounds, ICP
// broker pairing, per-companion Personal Workspaces and intake screening, and
// per-account Discord docks.
import { createComponentLogger } from '../../../shared/logger.js';
import type { SharedCompanionWorkspaceReader } from '../../../persistence/workspaces/shared-workspace-reader.js';
import type { GatewayMultiCompanionConfig } from '../multi-companion.js';
import type { GatewayServerOptions } from './options.js';

const log = createComponentLogger('Gateway');

/** Checks that precede ICP autonomy broker construction (order preserved). */
export function assertGatewayTopologyOptions(
  options: GatewayServerOptions,
  multiCompanion: GatewayMultiCompanionConfig,
  sharedWorkspaceReader: SharedCompanionWorkspaceReader | null,
): void {
  // Fail at boot rather than on the first operator request: a gateway that
  // starts and then cannot list the shared workspace hides the missing
  // setting behind an RPC error nobody is watching.
  if (sharedWorkspaceReader && !options.sharedWorkspaceListBounds) {
    throw new Error(
      'GatewayServer exposes a governed shared workspace without listing bounds; '
      + 'settings.json must declare sharedWorkspaceListPageSize and '
      + 'sharedWorkspaceListPageBytes',
    );
  }
  if (options.companionChannels && !multiCompanion.enabled) {
    throw new Error(
      'GatewayServer received a companionChannels lane while multi-companion is disabled; '
      + 'the inter-companion lane must not exist in single-companion topology',
    );
  }
  if (options.icpAutonomyStore && !multiCompanion.enabled) {
    throw new Error(
      'GatewayServer received an icpAutonomyStore while multi-companion is disabled; '
      + 'the autonomy broker must not exist in single-companion topology',
    );
  }
  if (Boolean(options.icpAutonomyStore) !== Boolean(options.icpInitiationPolicyAuthority)) {
    throw new Error(
      'GatewayServer requires icpAutonomyStore and icpInitiationPolicyAuthority together',
    );
  }
}

/** Fleet workspace/intake-screening ownership and per-account Discord docks. */
export function assertGatewayFleetScreeningAndDocks(
  options: GatewayServerOptions,
  multiCompanion: GatewayMultiCompanionConfig,
  discordAccountRoutingActive: () => boolean,
): void {
  if (multiCompanion.enabled) {
    const missingWorkspaceRoots = multiCompanion.fleetCompanionIds.filter(
      (companionId) => {
        const workspacePath = multiCompanion.personalWorkspaceByCompanionId[companionId];
        return typeof workspacePath !== 'string' || !workspacePath.trim();
      },
    );
    if (missingWorkspaceRoots.length > 0) {
      throw new Error(
        'Multi-companion gateway requires one resolved Personal Workspace per fleet companion; '
        + `missing: ${missingWorkspaceRoots.join(', ')}`,
      );
    }
    log.info('Multi-companion gateway routing enabled', {
      channelRouting: multiCompanion.channelRouting,
      discordAccounts: multiCompanion.discordAccounts,
      pluginAccounts: multiCompanion.pluginAccounts,
    });
    if (options.intakeScreening || options.visionIntake) {
      throw new Error(
        'Multi-companion gateway intake screening must use companion-owned providers, not singleton services',
      );
    }
    if (!options.intakeScreeningProvider || !options.visionIntakeProvider) {
      throw new Error(
        'Multi-companion gateway requires companion-owned text and vision intake screening providers',
      );
    }
    for (const companionId of multiCompanion.fleetCompanionIds) {
      const screening = options.intakeScreeningProvider(companionId);
      if (!screening || screening.globalMode !== options.intakeScreeningMode) {
        throw new Error(
          `Fleet intake screening mode=${options.intakeScreeningMode} has no matching service for companion ${companionId}`,
        );
      }
      // Resolve every vision owner at construction too. Null is an explicit,
      // valid disabled posture; a missing/unknown owner must throw here.
      options.visionIntakeProvider(companionId);
    }
  } else {
    if (
      !options.intakeScreening
      || options.intakeScreening.globalMode !== options.intakeScreeningMode
    ) {
      throw new Error(
        `Single-companion intake screening mode=${options.intakeScreeningMode} has no matching service`,
      );
    }
  }
  if (discordAccountRoutingActive()) {
    const missingDocks = [...new Set(Object.values(multiCompanion.discordAccounts))]
      .filter(companionId => !options.discordAccountDocks?.has(companionId));
    if (missingDocks.length > 0) {
      throw new Error(
        'Multi-account discord routing requires an outbound dock per routed companion; '
        + `missing docks for: ${missingDocks.join(', ')}`,
      );
    }
  }
}
