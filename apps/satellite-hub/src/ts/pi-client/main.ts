import { loadPiClientConfig, resolveProjectRoot } from "../shared/env.js";
import { PiRealtimeClient } from "./client.js";
import { PiClientApiServer } from "./mic-control-server.js";
import { HubOpenAiRelayClient } from "./relay-client.js";

async function main(): Promise<void> {
  const config = loadPiClientConfig(resolveProjectRoot());
  const realtimeClient = config.realtimeAudioEnabled
    ? new PiRealtimeClient(config)
    : null;
  const relayClient = config.control
    ? new HubOpenAiRelayClient(config)
    : null;
  if (config.control) {
    if (!relayClient) {
      throw new Error("Relay client must be available when the Pi client API is enabled");
    }
    relayClient.start();
    const apiServer = new PiClientApiServer(config.control, relayClient, realtimeClient);
    await apiServer.start();
    console.log(
      `TS Pi client API listening on http://${config.control.bindHost}:${String(config.control.port)}/`,
    );
  }
  if (realtimeClient) {
    realtimeClient.start();
    console.log(`TS Pi realtime client connecting to ${config.hubUrl}`);
    return;
  }
  console.log(`TS Pi relay-only client connecting to ${config.hubUrl}`);
}

void main().catch((error) => {
  console.error("TS Pi client failed to start:", error);
  process.exit(1);
});
