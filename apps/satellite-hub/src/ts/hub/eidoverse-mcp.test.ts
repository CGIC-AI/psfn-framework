import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EidoverseMcpClient,
  EidoverseMcpUnavailableError,
  loadEidoverseMcpConfig,
  resolveEidoverseCredentialFromEnv,
  type EidoverseMcpConfig,
  type EidoverseMcpLogger,
} from "./eidoverse-mcp.js";

const STUB_SERVER_PATH = fileURLToPath(
  new URL("../test-support/eidoverse-mcp-stub-server.js", import.meta.url),
);
const JOIN_TOKEN = "eidoverse-test-join-token";
const TOKEN_REF = "TEST_EIDOVERSE_JOIN_TOKEN";
const WORLD_URL = "ws://192.0.2.60:8787/world";

test("starts a real MCP stdio session and exposes only Phase-1 embodiment calls", async () => {
  const client = new EidoverseMcpClient(
    configFor("normal"),
    async () => JOIN_TOKEN,
  );
  await client.start();
  try {
    assert.equal(await client.look(), "A sunlit atrium with two pending paths.");
    await client.say("Hello from the Hub");
    assert.deepEqual(await client.pendingPings(), ["north gate", "south gate"]);

    assert.equal("spawn" in client, false);
    assert.equal("place" in client, false);
    assert.equal("worldVerb" in client, false);
    assert.equal("callTool" in client, false);
  } finally {
    await client.close();
  }
});

test("fails closed when a tool result or outbound speech contains Hub credentials", async () => {
  const logMessages: string[] = [];
  const logger: EidoverseMcpLogger = {
    info: (message) => logMessages.push(message),
    warn: (message) => logMessages.push(message),
  };
  const client = new EidoverseMcpClient(
    configFor("secret-look"),
    async () => JOIN_TOKEN,
    { logger },
  );
  await client.start();
  try {
    await assert.rejects(
      () => client.look(),
      (error: unknown) => safeFailure(error, "Eidoverse MCP look request failed"),
    );
    await assert.rejects(
      () => client.say(`repeat ${JOIN_TOKEN}`),
      (error: unknown) => safeFailure(error, "Eidoverse MCP say request failed"),
    );
    assert.doesNotMatch(logMessages.join("\n"), sensitivePattern());
  } finally {
    await client.close();
  }
});

test("disconnects fail closed and consume a bounded reconnect budget", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-mcp-reconnect-"));
  const launchCountPath = path.join(tempDir, "launch-count.txt");
  const config = configFor("disconnect", launchCountPath, {
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    reconnectMaxAttempts: 2,
  });
  const client = new EidoverseMcpClient(config, async () => JOIN_TOKEN);
  await client.start();
  try {
    await waitFor(() => readLaunchCount(launchCountPath) === 3);
    await delay(30);
    assert.equal(readLaunchCount(launchCountPath), 3, "initial connection plus two reconnect attempts");
    for (const request of [
      () => client.look(),
      () => client.say("still there?"),
      () => client.pendingPings(),
    ]) {
      await assert.rejects(request, EidoverseMcpUnavailableError);
    }
  } finally {
    await client.close();
  }
});

test("loads an optional stdio configuration with an unresolved token reference", () => {
  const config = loadEidoverseMcpConfig({
    EIDOVERSE_MCP_ENABLED: "true",
    EIDOVERSE_MCP_COMMAND: "/usr/bin/node",
    EIDOVERSE_MCP_ARGS_JSON: '["/opt/eidoverse/mcpl/server.js"]',
    EIDOVERSE_MCP_WORLD_URL: WORLD_URL,
    EIDOVERSE_MCP_TOKEN_REF: TOKEN_REF,
    EIDOVERSE_MCP_WORLD_NAME: "atrium",
    EIDOVERSE_MCP_AGENT_NAME: "companion",
    EIDOVERSE_MCP_RECONNECT_BASE_MS: "25",
    EIDOVERSE_MCP_RECONNECT_MAX_MS: "250",
    EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS: "4",
    EIDOVERSE_MCP_REQUEST_TIMEOUT_MS: "2000",
  });

  assert.deepEqual(config, {
    command: "/usr/bin/node",
    args: ["/opt/eidoverse/mcpl/server.js"],
    worldUrl: WORLD_URL,
    tokenRef: TOKEN_REF,
    worldName: "atrium",
    agentName: "companion",
    reconnectBaseMs: 25,
    reconnectMaxMs: 250,
    reconnectMaxAttempts: 4,
    requestTimeoutMs: 2000,
  });
  assert.equal("joinToken" in config!, false);
  assert.equal(loadEidoverseMcpConfig({ EIDOVERSE_MCP_ENABLED: "false" }), null);
});

test("credential references resolve in Hub custody without leaking values in failures", async () => {
  assert.equal(
    await resolveEidoverseCredentialFromEnv(TOKEN_REF, { [TOKEN_REF]: JOIN_TOKEN }),
    JOIN_TOKEN,
  );
  await assert.rejects(
    () => resolveEidoverseCredentialFromEnv(TOKEN_REF, {}),
    (error: unknown) => {
      const message = String(error);
      assert.doesNotMatch(message, sensitivePattern());
      return /credential reference could not be resolved/.test(message);
    },
  );
});

function configFor(
  mode: string,
  recordPath?: string,
  overrides: Partial<EidoverseMcpConfig> = {},
): EidoverseMcpConfig {
  return {
    command: process.execPath,
    args: [STUB_SERVER_PATH, mode, ...(recordPath ? [recordPath] : [])],
    worldUrl: WORLD_URL,
    tokenRef: TOKEN_REF,
    worldName: "atrium",
    agentName: "companion",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

function safeFailure(error: unknown, expectedMessage: string): boolean {
  const message = String(error);
  assert.match(message, new RegExp(expectedMessage));
  assert.doesNotMatch(message, sensitivePattern());
  return true;
}

function sensitivePattern(): RegExp {
  return new RegExp([JOIN_TOKEN, TOKEN_REF, WORLD_URL].map(escapeRegex).join("|"));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readLaunchCount(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  return Number.parseInt(fs.readFileSync(filePath, "utf8"), 10);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for reconnect attempts");
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
