import fs from "node:fs";

import { loadHubConfig, resolveProjectRoot } from "../shared/env.js";
import { RealtimeHubServer } from "./server.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { HomeAssistantControlServer } from "./home-assistant/control-server.js";

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const config = loadHubConfig(projectRoot);
  fs.mkdirSync(config.artifactsRoot, { recursive: true });
  const server = new RealtimeHubServer(config);
  const homeAssistant = config.homeAssistant ? new HomeAssistantClient(config.homeAssistant) : null;
  const control = config.control && homeAssistant
    ? new HomeAssistantControlServer(config.control, homeAssistant)
    : null;
  homeAssistant?.start();
  await control?.start();
  await server.start();
  console.log(`TS hub listening on ws://${config.bindHost}:${config.port}/`);
  if (control) {
    console.log(`Hub control listening on http://${config.control?.bindHost}:${config.control?.port}/internal/v1/`);
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await control?.close();
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
