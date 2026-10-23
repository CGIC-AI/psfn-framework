import { loadHubConfig } from "../shared/env.js";
import { RealtimeHubServer } from "../hub/server.js";

let providerCalls = 0;
const server = new RealtimeHubServer(loadHubConfig(process.cwd()), {
  agent: {
    async *streamReply() { providerCalls += 1; yield "Valid reply"; return "Valid reply"; },
    async close() {},
  },
  voxtaTts: null,
  realtimeStt: async () => { providerCalls += 1; return { text: "Valid transcript", provider: "test-boundary", latencyMs: 0 }; },
  voxtaStt: { async transcribePcm() { providerCalls += 1; return { text: "Valid transcript" }; } },
});
await server.start();
const address = server.address();
if (!address || typeof address === "string") throw new Error("Hub child did not bind TCP");
process.send?.({ type: "listening", port: address.port });
process.on("message", message => {
  if (message === "status") process.send?.({ type: "status", providerCalls, rss: process.memoryUsage().rss });
});
process.on("SIGTERM", () => { void server.close().finally(() => process.exit()); });
