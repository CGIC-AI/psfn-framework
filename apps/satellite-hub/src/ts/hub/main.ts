import { HubResources } from "./transport-resources.js";
import { hubConsole as console } from "../shared/private-log.js";
import { privateDirectory } from "../shared/private-artifacts.js";

import { loadHubConfig, resolveProjectRoot } from "../shared/env.js";
import {
  EidoverseMcpClient,
  loadEidoverseMcpConfig,
  resolveEidoverseCredentialFromEnv,
} from "./eidoverse-mcp.js";
import {
  EidoverseBodyRunner,
  claimGrantsEidoverseBodyActions,
  loadEidoverseBodyRunnerConfig,
} from "./eidoverse-body-runner.js";
import { EidoverseMcplClient } from "./eidoverse-mcpl-client.js";
import { EIDOVERSE_TRAVEL_FEATURE_SET } from "./eidoverse-mcpl-wire.js";
import {
  loadEidoverseMcpTransport,
  loadEidoverseMcplConfig,
} from "./eidoverse-mcpl-config.js";
import { createEidoverseMcplProductionLifecycle } from "./eidoverse-mcpl-runtime.js";
import {
  EidoverseSnapshotSource,
  claimGrantsEidoverseVision,
  loadEidoverseSnapshotConfig,
  type EidoverseSnapshotOrigin,
} from "./eidoverse-snapshot.js";
import { createEidoverseProductionWakeLifecycle } from "./eidoverse-wake-runtime.js";
import { RealtimeHubServer } from "./server.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { HubControlServer, type HubWorldControlPort } from "./home-assistant/control-server.js";

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const config = loadHubConfig(projectRoot);
  const resources = new HubResources(config.limits);
  // Transport selection is explicit and defaults to the Phase 1 poll, so a
  // deployment whose world fronts only the stdio MCP door keeps working when
  // this Hub learns to speak MCPL.
  const eidoverseTransport = loadEidoverseMcpTransport();
  const eidoverseConfig = eidoverseTransport === "poll" ? loadEidoverseMcpConfig() : null;
  const eidoverseMcplConfig = eidoverseTransport === "mcpl" ? loadEidoverseMcplConfig() : null;
  privateDirectory(config.artifactsRoot);
  const homeAssistant = config.homeAssistant ? new HomeAssistantClient(config.homeAssistant, undefined, config.limits) : null;
  const hubLogger = console;
  const eidoverse = eidoverseConfig
    ? new EidoverseMcpClient(eidoverseConfig, resolveEidoverseCredentialFromEnv, {
        logger: hubLogger,
      })
    : null;
  const eidoverseMcpl = eidoverseMcplConfig
    ? new EidoverseMcplClient(eidoverseMcplConfig, resolveEidoverseCredentialFromEnv, {
        logger: hubLogger,
        limits: config.limits,
      })
    : null;
  // The body runner reaches its tools through a narrow structural port, so it
  // works on either transport — both clients expose the same walk_to/face/stop
  // wrappers and nothing world-editing.
  const eidoverseTools = eidoverseMcpl ?? eidoverse;
  const eidoverseBody = eidoverseTools
    && claimGrantsEidoverseBodyActions(config.psfn.satelliteClaim)
    ? new EidoverseBodyRunner(loadEidoverseBodyRunnerConfig(), eidoverseTools, {
        logger: hubLogger,
      })
    : null;
  // Snapshot works on either transport. Each one names the URL its origin may
  // be derived from — the stdio world URL, or the MCPL door URL — and a
  // deployment whose renderer is not on that host states
  // EIDOVERSE_SNAPSHOT_BASE_URL instead. Neither derivation can carry the
  // identity token: the poll world URL's query is dropped, and the door URL is
  // credential-free by construction because the token is attached at dial time.
  const eidoverseSnapshotOrigin: EidoverseSnapshotOrigin | null = eidoverseConfig
    ? {
        transport: "poll",
        agentName: eidoverseConfig.agentName,
        worldUrl: eidoverseConfig.worldUrl,
      }
    : eidoverseMcplConfig
      ? {
          transport: "mcpl",
          agentName: eidoverseMcplConfig.agentName,
          doorUrl: eidoverseMcplConfig.doorUrl,
        }
      : null;
  // An enabled snapshot with an unusable origin throws here and the process
  // never reaches listen: vision that was asked for is never a silent no-op.
  const eidoverseSnapshotConfig = eidoverseSnapshotOrigin
    && claimGrantsEidoverseVision(config.psfn.satelliteClaim)
    ? loadEidoverseSnapshotConfig(eidoverseSnapshotOrigin)
    : null;
  const eidoverseSnapshot = eidoverseSnapshotConfig
    ? new EidoverseSnapshotSource(eidoverseSnapshotConfig, {
        artifactsRoot: config.artifactsRoot,
        logger: hubLogger,
      })
    : null;
  const server = new RealtimeHubServer(config, {
    resources,
    eidoverse: eidoverseMcplConfig && eidoverseMcpl
      ? {
          worldName: eidoverseMcplConfig.worldName,
          agentName: eidoverseMcplConfig.agentName,
          look: eidoverseMcpl,
          onLookError: () => console.warn("Eidoverse MCPL look failed"),
          say: eidoverseMcpl,
          logger: hubLogger,
          // The operator's feature-set selection decides whether this Hub
          // carries a travel port at all: withholding `eidoverse.travel`
          // removes the surface rather than relying on the door to refuse it.
          ...(eidoverseMcplConfig.featureSets.includes(EIDOVERSE_TRAVEL_FEATURE_SET)
            ? { travel: eidoverseMcpl }
            : {}),
          ...(eidoverseBody ? { body: eidoverseBody } : {}),
          ...(eidoverseSnapshot ? { snapshot: eidoverseSnapshot } : {}),
        }
      : eidoverseConfig && eidoverse
        ? {
            worldName: eidoverseConfig.worldName,
            agentName: eidoverseConfig.agentName,
            look: eidoverse,
            onLookError: () => console.warn("Eidoverse MCP look failed"),
            say: eidoverse,
            ...(eidoverseBody ? { body: eidoverseBody } : {}),
            ...(eidoverseSnapshot ? { snapshot: eidoverseSnapshot } : {}),
          }
        : null,
  });
  const eidoverseProduction = eidoverseMcplConfig && eidoverseMcpl
    ? createEidoverseMcplProductionLifecycle(eidoverseMcpl, server, {
        ...eidoverseMcplConfig,
        agentNames: [eidoverseMcplConfig.agentName, ...(eidoverseMcplConfig.agentAliases ?? [])],
      }, { logger: hubLogger })
    : eidoverseConfig && eidoverse
      ? createEidoverseProductionWakeLifecycle(eidoverse, server, eidoverseConfig, {
          resources,
          logger: hubLogger,
        })
      : null;
  // The control port carries the companion's own world-avatar surface whenever
  // an Eidoverse emanation exists, and Home Assistant only when it is enabled.
  // Neither needs a device registry: the gateway's control token is the only
  // credential these routes admit.
  const worldControl: HubWorldControlPort | null = server.hasEidoverse()
    ? {
        perceive: () => server.perceiveEidoverse(),
        map: () => server.mapEidoverse(),
        snapshot: (view) => server.snapshotEidoverse(view),
        move: (input) => server.moveEidoverseAvatar(input),
        act: (verb, args) => server.actEidoverse(verb, args),
      }
    : null;
  const control = config.control
    ? new HubControlServer(config.control, homeAssistant, config.deviceRegistry, worldControl)
    : null;
  try {
    homeAssistant?.start();
    await control?.start();
    if (eidoverseProduction) {
      await eidoverseProduction.start();
    } else {
      await server.start();
    }
  } catch (error) {
    await resources.shutdown([
      () => control?.close(),
      () => homeAssistant?.close(),
      () => eidoverseBody?.close(),
      () => eidoverseProduction ? eidoverseProduction.close() : server.close(),
    ]).catch(() => undefined);
    throw error;
  }
  console.info("hub.listen", { port: config.port });
  if (control) {
    console.info("hub.control.listen", { port: config.control?.port });
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await resources.shutdown([
      () => control?.close(),
      () => homeAssistant?.close(),
      () => eidoverseBody?.close(),
      () => eidoverseProduction ? eidoverseProduction.close() : server.close(),
    ]);
  };
  const requestStop = () => { void stop().catch((error) => { console.error("Hub shutdown failed", error); process.exitCode = 1; }); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
