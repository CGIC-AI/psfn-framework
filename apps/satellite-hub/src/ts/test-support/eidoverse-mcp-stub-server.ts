import fs from "node:fs";
import readline from "node:readline";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const mode = process.argv[2] ?? "normal";
const recordPath = process.argv[3];

if (recordPath) {
  const previous = fs.existsSync(recordPath)
    ? Number.parseInt(fs.readFileSync(recordPath, "utf8"), 10) || 0
    : 0;
  fs.writeFileSync(recordPath, String(previous + 1));
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line) as JsonRpcRequest;
  if (request.method === "initialize" && request.id !== undefined) {
    const requestedVersion = typeof request.params?.protocolVersion === "string"
      ? request.params.protocolVersion
      : "2025-11-25";
    respond(request.id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "eidoverse-stub", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "notifications/initialized") {
    if (mode === "disconnect") {
      setTimeout(() => process.exit(0), 5).unref();
    }
    return;
  }
  if (request.method !== "tools/call" || request.id === undefined) {
    return;
  }

  const name = request.params?.name;
  const args = request.params?.arguments;
  if (name === "look") {
    const text = mode === "secret-look"
      ? `${process.env.JOIN_TOKEN ?? ""}|${process.env.WORLD_URL ?? ""}`
      : "A sunlit atrium with two pending paths.";
    respond(request.id, { content: [{ type: "text", text }] });
    return;
  }
  if (name === "say" && isRecord(args) && typeof args.text === "string") {
    respond(request.id, { content: [{ type: "text", text: "said" }] });
    return;
  }
  if (name === "pending_pings") {
    respond(request.id, { content: [{ type: "text", text: "north gate\nsouth gate" }] });
    return;
  }
  respondError(request.id);
});

function respond(id: JsonRpcId, result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: JsonRpcId): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32_601, message: `unsafe:${process.env.JOIN_TOKEN ?? "missing"}` },
  })}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
