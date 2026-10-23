import { loadHubConfig } from "../shared/env.js";
import { RealtimeHubServer } from "../hub/server.js";

let providerCalls = 0;
let pendingProviders = 0;
let acceptedPcmBytes = 0;
let providerAborts = 0;
const releaseStt = new Set<() => void>();
const server = new RealtimeHubServer(loadHubConfig(process.cwd()), {
  agent: {
    async *streamReply(input) {
      providerCalls += 1;
      const text = process.env.HUB_TEST_PRIVATE_SENTINELS === "true" ? `ASSISTANT_PRIVATE_SENTINEL ${input.userText}` : "Valid reply";
      yield text; return text;
    },
    async close() { if (process.env.HUB_TEST_AGENT_CLOSE_FAIL === "true") throw new Error("PRIVATE_CLOSE_FAILURE_SENTINEL"); },
  },
  voxtaTts: null,
  realtimeStt: async (pcm, signal) => {
    acceptedPcmBytes += pcm.length;
    providerCalls += 1;
    if (process.env.HUB_TEST_DEFER_REALTIME_STT === "true") {
      pendingProviders += 1;
      try {
        await new Promise<void>((resolve, reject) => {
          const done = (): void => { releaseStt.delete(done); signal.removeEventListener("abort", aborted); resolve(); };
          const aborted = (): void => { providerAborts += 1; if (process.env.HUB_TEST_IGNORE_PROVIDER_ABORT !== "true") { releaseStt.delete(done); reject(new Error("Test provider aborted")); } };
          releaseStt.add(done); signal.addEventListener("abort", aborted, { once: true });
        });
      } finally { pendingProviders -= 1; }
    }
    return { text: process.env.HUB_TEST_PRIVATE_SENTINELS === "true" ? "TRANSCRIPT_PRIVATE_SENTINEL" : "Valid transcript", provider: "test-boundary", latencyMs: 0 };
  },
  voxtaStt: { async transcribePcm(input) {
    providerCalls += 1;
    if (process.env.HUB_TEST_DEFER_VOXTA_STT === "true") {
      const signal = (input as { signal?: AbortSignal }).signal;
      pendingProviders += 1;
      try {
        await new Promise<void>((resolve, reject) => {
          const done = (): void => { releaseStt.delete(done); signal?.removeEventListener("abort", aborted); resolve(); };
          const aborted = (): void => { if (process.env.HUB_TEST_IGNORE_PROVIDER_ABORT !== "true") { releaseStt.delete(done); reject(new Error("Test provider aborted")); } };
          releaseStt.add(done);
          signal?.addEventListener("abort", aborted, { once: true });
        });
      } finally { pendingProviders -= 1; }
    }
    return { text: "Valid transcript" };
  } },
});
await server.start();
const address = server.address();
if (!address || typeof address === "string") throw new Error("Hub child did not bind TCP");
process.send?.({ type: "listening", port: address.port });
process.on("message", message => {
  if (message === "status") process.send?.({ type: "status", providerCalls, pendingProviders, providerAborts, acceptedPcmBytes, rss: process.memoryUsage().rss });
  if (message === "releaseStt") for (const release of releaseStt) release();
  if (message === "closeServer") void server.close().then(
    () => process.send?.({ type: "closed", outcome: "success", address: server.address(), providerAborts, pendingProviders }),
    () => process.send?.({ type: "closed", outcome: "failed", address: server.address(), providerAborts, pendingProviders }),
  );
});
process.on("SIGTERM", () => { void server.close().then(() => process.exit(0), () => process.exit(1)); });
