import fs from "node:fs";

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
import {
  loadEidoverseMcpTransport,
  loadEidoverseMcplConfig,
} from "./eidoverse-mcpl-config.js";
import { createEidoverseMcplProductionLifecycle } from "./eidoverse-mcpl-runtime.js";
import {
  EidoverseSnapshotSource,
  claimGrantsEidoverseVision,
  loadEidoverseSnapshotConfig,
} from "./eidoverse-snapshot.js";
import { createEidoverseProductionWakeLifecycle } from "./eidoverse-wake-runtime.js";
import { RealtimeHubServer } from "./server.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { HomeAssistantControlServer } from "./home-assistant/control-server.js";

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const config = loadHubConfig(projectRoot);
  // Transport selection is explicit and defaults to the Phase 1 poll, so a
  // deployment whose world fronts only the stdio MCP door keeps working when
  // this Hub learns to speak MCPL.
  const eidoverseTransport = loadEidoverseMcpTransport();
  const eidoverseConfig = eidoverseTransport === "poll" ? loadEidoverseMcpConfig() : null;
  const eidoverseMcplConfig = eidoverseTransport === "mcpl" ? loadEidoverseMcplConfig() : null;
  fs.mkdirSync(config.artifactsRoot, { recursive: true });
  const homeAssistant = config.homeAssistant ? new HomeAssistantClient(config.homeAssistant) : null;
  const hubLogger = {
    info: (message: string) => console.info(message),
    warn: (message: string) => console.warn(message),
  };
  const eidoverse = eidoverseConfig
    ? new EidoverseMcpClient(eidoverseConfig, resolveEidoverseCredentialFromEnv, {
        logger: hubLogger,
      })
    : null;
  const eidoverseMcpl = eidoverseMcplConfig
    ? new EidoverseMcplClient(eidoverseMcplConfig, resolveEidoverseCredentialFromEnv, {
        logger: hubLogger,
      })
    : null;
  // The body runner reaches its tools through a narrow structural port, so it
  // works on either transport — both clients expose the same walk_to/face/stop
  // wrappers and nothing world-editing.
  const eidoverseTools = eidoverseMcpl ?? eidoverse;
  const eidoverseBody = eidoverseTools
    && claimGrantsEidoverseBodyActions(config.psfn.satelliteClaim)
    ? new EidoverseBodyRunner(loadEidoverseBodyRunnerConfig(), eidoverseTools, {
        logger: { warn: (message) => console.warn(message) },
      })
    : null;
  // Snapshot derives its HTTP origin from the stdio transport's world URL, so
  // it stays on that transport until an MCPL deployment states its renderer
  // origin explicitly (psfn-framework-mdbgp.13's own follow-up, not this lane).
  const eidoverseSnapshotConfig = eidoverseConfig
    && claimGrantsEidoverseVision(config.psfn.satelliteClaim)
    ? loadEidoverseSnapshotConfig(eidoverseConfig)
    : null;
  const eidoverseSnapshot = eidoverseSnapshotConfig
    ? new EidoverseSnapshotSource(eidoverseSnapshotConfig, {
        artifactsRoot: config.artifactsRoot,
        logger: { warn: (message) => console.warn(message) },
      })
    : null;
  const server = new RealtimeHubServer(config, {
    eidoverse: eidoverseMcplConfig && eidoverseMcpl
      ? {
          worldName: eidoverseMcplConfig.worldName,
          agentName: eidoverseMcplConfig.agentName,
          look: eidoverseMcpl,
          onLookError: () => console.warn("Eidoverse MCPL look failed"),
          say: eidoverseMcpl,
          travel: eidoverseMcpl,
          ...(eidoverseBody ? { body: eidoverseBody } : {}),
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
    ? createEidoverseMcplProductionLifecycle(eidoverseMcpl, server, eidoverseMcplConfig, {
        logger: { warn: (message) => console.warn(message) },
      })
    : eidoverseConfig && eidoverse
      ? createEidoverseProductionWakeLifecycle(eidoverse, server, eidoverseConfig, {
          logger: { warn: (message) => console.warn(message) },
        })
      : null;
  const control = config.control && homeAssistant && config.deviceRegistry
    ? new HomeAssistantControlServer(config.control, homeAssistant, config.deviceRegistry)
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
    await Promise.allSettled([
      control?.close(),
      homeAssistant?.close(),
      eidoverseBody?.close(),
      eidoverseProduction ? eidoverseProduction.close() : server.close(),
    ]);
    throw error;
  }
  console.log(`TS hub listening on ws://${config.bindHost}:${config.port}/`);
  if (control) {
    console.log(`Hub control listening on http://${config.control?.bindHost}:${config.control?.port}/internal/v1/`);
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const results = await Promise.allSettled([
      control?.close(),
      homeAssistant?.close(),
      eidoverseBody?.close(),
      eidoverseProduction ? eidoverseProduction.close() : server.close(),
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Satellite Hub shutdown failed");
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
