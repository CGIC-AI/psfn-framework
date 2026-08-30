import fs from "node:fs";

import { loadHubConfig, resolveProjectRoot } from "../shared/env.js";
import {
  EidoverseMcpClient,
  loadEidoverseMcpConfig,
  resolveEidoverseCredentialFromEnv,
} from "./eidoverse-mcp.js";
import { createEidoverseProductionWakeLifecycle } from "./eidoverse-wake-runtime.js";
import { RealtimeHubServer } from "./server.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { HomeAssistantControlServer } from "./home-assistant/control-server.js";

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const config = loadHubConfig(projectRoot);
  const eidoverseConfig = loadEidoverseMcpConfig();
  fs.mkdirSync(config.artifactsRoot, { recursive: true });
  const homeAssistant = config.homeAssistant ? new HomeAssistantClient(config.homeAssistant) : null;
  const eidoverse = eidoverseConfig
    ? new EidoverseMcpClient(eidoverseConfig, resolveEidoverseCredentialFromEnv, {
        logger: {
          info: (message) => console.info(message),
          warn: (message) => console.warn(message),
        },
      })
    : null;
  const server = new RealtimeHubServer(config, {
    eidoverse: eidoverseConfig && eidoverse
      ? {
          worldName: eidoverseConfig.worldName,
          agentName: eidoverseConfig.agentName,
          look: eidoverse,
          onLookError: () => console.warn("Eidoverse MCP look failed"),
          say: eidoverse,
        }
      : null,
  });
  const eidoverseProduction = eidoverseConfig && eidoverse
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
