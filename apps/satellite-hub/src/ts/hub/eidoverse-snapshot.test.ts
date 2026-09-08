import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import type { EidoverseMcpConfig } from "./eidoverse-mcp.js";
import {
  EidoverseSnapshotSource,
  claimGrantsEidoverseVision,
  deriveEidoverseSnapshotBaseUrl,
  deriveEidoverseSnapshotBaseUrlFromDoorUrl,
  loadEidoverseSnapshotConfig,
  type EidoverseSnapshotOrigin,
} from "./eidoverse-snapshot.js";
import { EmbodiedSessionRegistry } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

const WORLD_URL = "ws://192.0.2.61:8787/world/ws?token=join-secret";
const MCPL_DOOR_URL = "wss://world.invalid/mcpl";
const SNAPSHOT_TIMEOUT_MS = 500;
const SNAPSHOT_MAX_BYTES = 4_096;
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "A quiet room.";
    return "A quiet room.";
  }

  async close(): Promise<void> {}
}

type SnapHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => void;

interface SnapServer {
  baseUrl: string;
  requestedUrls: string[];
  close(): Promise<void>;
}

test("the snapshot base URL drops the door's scheme, ws suffix, and join credential", () => {
  assert.equal(
    deriveEidoverseSnapshotBaseUrl("wss://world.invalid/world/ws?token=join-secret"),
    "https://world.invalid/world",
  );
  assert.equal(deriveEidoverseSnapshotBaseUrl("ws://192.0.2.61:8787/ws"), "http://192.0.2.61:8787");
  assert.throws(() => deriveEidoverseSnapshotBaseUrl("wss://user:pass@world.invalid/ws"), /credential-free/u);
});

test("the MCPL door yields a same-host origin only across the conventional door path", () => {
  assert.equal(deriveEidoverseSnapshotBaseUrlFromDoorUrl(MCPL_DOOR_URL), "https://world.invalid");
  assert.equal(
    deriveEidoverseSnapshotBaseUrlFromDoorUrl("ws://127.0.0.1:8787/mcpl/"),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    deriveEidoverseSnapshotBaseUrlFromDoorUrl("wss://world.invalid/worlds/commons/mcpl"),
    "https://world.invalid/worlds/commons",
  );
  assert.equal(deriveEidoverseSnapshotBaseUrlFromDoorUrl("wss://world.invalid"), "https://world.invalid");
  // A gateway that routes the door somewhere else is not evidence about where
  // the renderer answers, so it is refused instead of guessed at.
  assert.throws(
    () => deriveEidoverseSnapshotBaseUrlFromDoorUrl("wss://gateway.invalid/tenants/acme/socket"),
    /EIDOVERSE_SNAPSHOT_BASE_URL is required/u,
  );
  assert.throws(
    () => deriveEidoverseSnapshotBaseUrlFromDoorUrl("wss://user:pass@world.invalid/mcpl"),
    /credential-free/u,
  );
});

test("no derived MCPL origin can carry the dial-time identity token", () => {
  const token = "door-identity-token";
  // The loader rejects a door URL with a query outright, but the derivation is
  // what the snapshot path actually calls: it must strip a token even when one
  // reaches it, and never keep it in the origin it hands the fetch.
  const derived = deriveEidoverseSnapshotBaseUrlFromDoorUrl(`wss://world.invalid/mcpl?token=${token}`);
  assert.equal(derived, "https://world.invalid");
  assert.equal(derived.includes(token), false);
  const configured = loadEidoverseSnapshotConfig(
    mcplOrigin(`wss://world.invalid/mcpl?token=${token}`),
    { EIDOVERSE_SNAPSHOT_ENABLED: "true" },
  );
  assert.equal(configured?.baseUrl, "https://world.invalid");
});

test("an MCPL hub that asks for vision gets an origin or a boot failure, never a no-op", () => {
  assert.equal(loadEidoverseSnapshotConfig(mcplOrigin(), {}), null, "vision is still off by default");
  assert.deepEqual(loadEidoverseSnapshotConfig(mcplOrigin(), { EIDOVERSE_SNAPSHOT_ENABLED: "true" }), {
    baseUrl: "https://world.invalid",
    worldName: "demo-world",
    agentName: "Aster Example",
    timeoutMs: 4_000,
    maxBytes: 4_000_000,
  });
  // An explicit origin satisfies the requirement whatever the door path is.
  assert.deepEqual(
    loadEidoverseSnapshotConfig(mcplOrigin("wss://gateway.invalid/tenants/acme/socket"), {
      EIDOVERSE_SNAPSHOT_ENABLED: "true",
      EIDOVERSE_SNAPSHOT_BASE_URL: "https://renderer.invalid/commons/",
    }),
    {
      baseUrl: "https://renderer.invalid/commons",
      worldName: "demo-world",
      agentName: "Aster Example",
      timeoutMs: 4_000,
      maxBytes: 4_000_000,
    },
  );
  // Neither configured nor derivable: fail closed at load, naming the fix.
  assert.throws(
    () => loadEidoverseSnapshotConfig(mcplOrigin("wss://gateway.invalid/tenants/acme/socket"), {
      EIDOVERSE_SNAPSHOT_ENABLED: "true",
    }),
    /EIDOVERSE_SNAPSHOT_BASE_URL is required/u,
  );
});

test("snapshots stay disabled by default and only load for explicitly enabled hubs", () => {
  const mcp = pollOrigin();
  assert.equal(loadEidoverseSnapshotConfig(mcp, {}), null, "vision is off unless it is asked for");
  assert.equal(loadEidoverseSnapshotConfig(mcp, { EIDOVERSE_SNAPSHOT_ENABLED: "false" }), null);
  assert.throws(() => loadEidoverseSnapshotConfig(mcp, { EIDOVERSE_SNAPSHOT_ENABLED: "yes" }));
  assert.deepEqual(loadEidoverseSnapshotConfig(mcp, { EIDOVERSE_SNAPSHOT_ENABLED: "true" }), {
    baseUrl: "http://192.0.2.61:8787/world",
    worldName: "demo-world",
    agentName: "Aster Example",
    timeoutMs: 4_000,
    maxBytes: 4_000_000,
  });
  assert.deepEqual(
    loadEidoverseSnapshotConfig(mcp, {
      EIDOVERSE_SNAPSHOT_ENABLED: "true",
      EIDOVERSE_SNAPSHOT_BASE_URL: "https://snapshots.invalid/world/",
      EIDOVERSE_SNAPSHOT_TIMEOUT_MS: "1500",
      EIDOVERSE_SNAPSHOT_MAX_BYTES: "2048",
    }),
    {
      baseUrl: "https://snapshots.invalid/world",
      worldName: "demo-world",
      agentName: "Aster Example",
      timeoutMs: 1_500,
      maxBytes: 2_048,
    },
  );
  assert.throws(() => loadEidoverseSnapshotConfig(mcp, {
    EIDOVERSE_SNAPSHOT_ENABLED: "true",
    EIDOVERSE_SNAPSHOT_BASE_URL: "ws://world.invalid/",
  }), /http or https/u);
  assert.throws(() => loadEidoverseSnapshotConfig(mcp, {
    EIDOVERSE_SNAPSHOT_ENABLED: "true",
    EIDOVERSE_SNAPSHOT_MAX_BYTES: "0",
  }));
});

test("only a vision-granting claim profile can reach first-person capture", () => {
  assert.equal(
    claimGrantsEidoverseVision(normalizeSatelliteClaimConfig({ capabilityProfile: "world-avatar" })),
    true,
  );
  for (const profile of ["voice-only", "text-only", "telemetry-only"] as const) {
    assert.equal(
      claimGrantsEidoverseVision(normalizeSatelliteClaimConfig({ capabilityProfile: profile })),
      false,
      `${profile} must not reach in-world vision`,
    );
  }
});

test("a served frame becomes a persisted vision capture on the door's exact query", async (t) => {
  const server = await startSnapServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
    response.end(PNG_BYTES);
  });
  const artifactsRoot = temporaryRoot(t);
  const source = new EidoverseSnapshotSource(snapshotConfig(server.baseUrl), {
    artifactsRoot,
    logger: { warn: () => undefined },
  });

  const capture = await source.capture("eidoverse:abc123");
  await server.close();

  assert.notEqual(capture, null);
  assert.equal(capture?.mimeType, "image/png");
  assert.equal(capture?.source, "eidoverse");
  assert.equal(capture?.sessionId, "eidoverse:abc123");
  assert.equal(capture?.bytes, PNG_BYTES.length);
  assert.equal(capture?.dataBase64, PNG_BYTES.toString("base64"));
  assert.deepEqual(fs.readFileSync(capture?.filePath ?? ""), PNG_BYTES);
  assert.deepEqual(server.requestedUrls, [
    "/snap?world=demo-world&follow=Aster+Example&view=first",
  ]);
});

test("every renderer failure mode degrades to text with no crash", async (t) => {
  const artifactsRoot = temporaryRoot(t);
  const cases: Array<{ label: string; handler: SnapHandler }> = [
    {
      label: "503 no renderer is serving the world",
      handler: (_request, response) => {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end('no renderer is currently serving world "demo-world"');
      },
    },
    {
      label: "404 the followed identity is not present",
      handler: (_request, response) => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end('"Aster Example" is not present in "demo-world"');
      },
    },
    {
      label: "504 the renderer timed out",
      handler: (_request, response) => {
        response.writeHead(504, { "content-type": "text/plain" });
        response.end("renderer timed out");
      },
    },
    {
      label: "a non-image body",
      handler: (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>not a frame</html>");
      },
    },
    {
      label: "a declared payload over the size budget",
      handler: (_request, response) => {
        const oversize = Buffer.alloc(SNAPSHOT_MAX_BYTES + 1);
        response.writeHead(200, { "content-type": "image/png", "content-length": oversize.length });
        response.end(oversize);
      },
    },
    {
      label: "an undeclared payload over the size budget",
      handler: (_request, response) => {
        response.writeHead(200, { "content-type": "image/png" });
        response.write(Buffer.alloc(SNAPSHOT_MAX_BYTES));
        response.end(Buffer.alloc(SNAPSHOT_MAX_BYTES));
      },
    },
    {
      label: "a renderer that never answers",
      handler: () => undefined,
    },
  ];

  for (const testCase of cases) {
    const server = await startSnapServer(testCase.handler);
    const warnings: string[] = [];
    const source = new EidoverseSnapshotSource(snapshotConfig(server.baseUrl), {
      artifactsRoot,
      logger: { warn: (message) => warnings.push(message) },
    });
    const capture = await source.capture("eidoverse:abc123");
    await server.close();
    assert.equal(capture, null, `${testCase.label} must degrade to text`);
    assert.equal(warnings.length, 1, `${testCase.label} logs exactly one sanitized warning`);
    assert.equal(
      warnings.every((message) => !message.includes("join-secret") && !message.includes("192.0.2.61")),
      true,
      `${testCase.label} must not log the world address or credential`,
    );
  }

  const unreachable = new EidoverseSnapshotSource(snapshotConfig("http://127.0.0.1:1"), {
    artifactsRoot,
    logger: { warn: () => undefined },
  });
  assert.equal(await unreachable.capture("eidoverse:abc123"), null);
  assert.deepEqual(
    fs.existsSync(path.join(artifactsRoot, "eidoverse-vision"))
      ? fs.readdirSync(path.join(artifactsRoot, "eidoverse-vision"))
      : [],
    [],
    "a failed capture writes no artifact",
  );
});

test("a turn attaches the frame on the Voxta seam and keeps unscreened pixels out of the session", async (t) => {
  const server = await startSnapServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
    response.end(PNG_BYTES);
  });
  const artifactsRoot = temporaryRoot(t);
  const agent = new FakeAgent();
  const sessions = new SessionStore(60);
  const adapter = createAdapter(agent, sessions, new EidoverseSnapshotSource(
    snapshotConfig(server.baseUrl),
    { artifactsRoot, logger: { warn: () => undefined } },
  ));
  adapter.connect();
  await adapter.handleAddressedUtterance({ utteranceId: "turn-1", userText: "What do you see?" });
  await server.close();
  adapter.disconnect();

  const channel = agent.calls[0]?.channel;
  assert.equal(channel?.visionCaptures?.length, 1);
  assert.equal(channel?.visionCaptureImages?.length, 1);
  assert.equal(channel?.visionCaptureImages?.[0]?.dataBase64, PNG_BYTES.toString("base64"));
  assert.equal(
    "dataBase64" in (channel?.visionCaptures?.[0] ?? {}),
    false,
    "the outbound channel record carries metadata only",
  );
  assert.equal(
    (channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.look"),
    true,
    "the text look tier is unchanged by vision",
  );
  const history = JSON.stringify(sessions.getHistory(adapter.conversationId));
  assert.equal(
    history.includes(PNG_BYTES.toString("base64")),
    false,
    "unscreened pixels are never written into the session transcript",
  );
});

test("an unavailable renderer leaves the turn with its text look notes", async (t) => {
  const server = await startSnapServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("no renderer");
  });
  const artifactsRoot = temporaryRoot(t);
  const agent = new FakeAgent();
  const sessions = new SessionStore(60);
  const adapter = createAdapter(agent, sessions, new EidoverseSnapshotSource(
    snapshotConfig(server.baseUrl),
    { artifactsRoot, logger: { warn: () => undefined } },
  ));
  adapter.connect();
  const reply = await adapter.handleAddressedUtterance({
    utteranceId: "turn-1",
    userText: "What do you see?",
  });
  await server.close();
  adapter.disconnect();

  assert.equal(reply, "A quiet room.");
  const channel = agent.calls[0]?.channel;
  assert.equal(channel?.visionCaptures, undefined);
  assert.equal(channel?.visionCaptureImages, undefined);
  assert.equal(
    (channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.look"),
    true,
  );
});

test("a capture source that throws never fails the turn", async () => {
  const agent = new FakeAgent();
  const sessions = new SessionStore(60);
  const warnings: string[] = [];
  const adapter = createAdapter(agent, sessions, {
    capture: async () => { throw new Error("renderer exploded"); },
  }, warnings);
  adapter.connect();
  assert.equal(
    await adapter.handleAddressedUtterance({ utteranceId: "turn-1", userText: "Look up." }),
    "A quiet room.",
  );
  adapter.disconnect();
  assert.equal(agent.calls[0]?.channel?.visionCaptures, undefined);
  assert.deepEqual(warnings, ["Eidoverse snapshot failed"]);
});

function createAdapter(
  agent: FakeAgent,
  sessions: SessionStore,
  snapshot: { capture(sessionId: string): Promise<never | null> } | EidoverseSnapshotSource,
  warnings?: string[],
): EidoverseEmbodiedSessionAdapter {
  return new EidoverseEmbodiedSessionAdapter({
    worldName: "demo-world",
    agentName: "Aster Example",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: null,
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions,
    agent,
    look: { look: async () => "You are in a quiet room." },
    say: { say: async () => undefined },
    snapshot,
    ...(warnings ? { logger: { warn: (message: string) => warnings.push(message) } } : {}),
  });
}

function mcpConfig(): EidoverseMcpConfig {
  return {
    command: process.execPath,
    args: [],
    worldUrl: WORLD_URL,
    tokenRef: "TEST_EIDOVERSE_SNAPSHOT_TOKEN",
    worldName: "demo-world",
    agentName: "Aster Example",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    pendingPingsPollIntervalMs: 1_000,
    ambientSayDebounceMs: 10_000,
  };
}

/** The poll transport's derivation input, taken from the same loaded config. */
function pollOrigin(): EidoverseSnapshotOrigin {
  const mcp = mcpConfig();
  return {
    transport: "poll",
    worldName: mcp.worldName,
    agentName: mcp.agentName,
    worldUrl: mcp.worldUrl,
  };
}

/** The MCPL transport's derivation input: the credential-free door URL. */
function mcplOrigin(doorUrl = MCPL_DOOR_URL): EidoverseSnapshotOrigin {
  return {
    transport: "mcpl",
    worldName: "demo-world",
    agentName: "Aster Example",
    doorUrl,
  };
}

function snapshotConfig(baseUrl: string): {
  baseUrl: string;
  worldName: string;
  agentName: string;
  timeoutMs: number;
  maxBytes: number;
} {
  return {
    baseUrl,
    worldName: "demo-world",
    agentName: "Aster Example",
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    maxBytes: SNAPSHOT_MAX_BYTES,
  };
}

function temporaryRoot(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-snapshot-"));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

async function startSnapServer(handler: SnapHandler): Promise<SnapServer> {
  const requestedUrls: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((request, response) => {
    requestedUrls.push(request.url ?? "");
    handler(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestedUrls,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
