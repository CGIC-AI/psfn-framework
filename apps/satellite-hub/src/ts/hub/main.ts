import fs from "node:fs";

import { loadHubConfig, resolveProjectRoot } from "../shared/env.js";
import {
  EidoverseMcpClient,
  loadEidoverseMcpConfig,
  resolveEidoverseCredentialFromEnv,
} from "./eidoverse-mcp.js";
import { RealtimeHubServer } from "./server.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { HomeAssistantControlServer } from "./home-assistant/control-server.js";

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const config = loadHubConfig(projectRoot);
  const eidoverseConfig = loadEidoverseMcpConfig();
  fs.mkdirSync(config.artifactsRoot, { recursive: true });
  const server = new RealtimeHubServer(config);
  const homeAssistant = config.homeAssistant ? new HomeAssistantClient(config.homeAssistant) : null;
  const eidoverse = eidoverseConfig
    ? new EidoverseMcpClient(eidoverseConfig, resolveEidoverseCredentialFromEnv, {
        logger: {
          info: (message) => console.info(message),
          warn: (message) => console.warn(message),
        },
      })
    : null;
  const control = config.control && homeAssistant && config.deviceRegistry
    ? new HomeAssistantControlServer(config.control, homeAssistant, config.deviceRegistry)
    : null;
  try {
    homeAssistant?.start();
    await eidoverse?.start();
    await control?.start();
    await server.start();
  } catch (error) {
    await Promise.allSettled([
      control?.close(),
      eidoverse?.close(),
      homeAssistant?.close(),
      server.close(),
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
    await control?.close();
    await eidoverse?.close();
    await homeAssistant?.close();
    await server.close();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
