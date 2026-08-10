import process from "node:process";

import WebSocket from "ws";

const text = (process.argv[2] || "").trim() || (await readStdin()).trim();
if (!text) {
  console.error("Usage: node scripts/psfn-thin-shell.mjs \"message\" [ws-url]");
  process.exit(2);
}

const wsUrl = process.argv[3] || process.env.HUB_WS_URL || "ws://127.0.0.1:8787/";
const deviceId = process.env.THIN_SHELL_DEVICE_ID || "thin-shell";
const deviceName = process.env.THIN_SHELL_DEVICE_NAME || "PSFN Thin Shell";
const sessionId = process.env.THIN_SHELL_SESSION_ID || `thin-shell:${deviceId}`;
const channelId = process.env.THIN_SHELL_CHANNEL_ID || undefined;

const socket = new WebSocket(wsUrl);
const startedAt = Date.now();
let channel = null;
let assistantText = "";
let sentInput = false;

const timeout = setTimeout(() => {
  console.error("thin shell timeout");
  socket.close();
  process.exit(1);
}, Number.parseInt(process.env.THIN_SHELL_TIMEOUT_MS || "30000", 10));

socket.on("open", () => {
  socket.send(JSON.stringify({
    type: "hello",
    deviceId,
    deviceName,
    sessionId,
    channelId,
    satelliteId: deviceId,
    satelliteName: deviceName,
    capabilities: {
      input: ["text"],
      output: ["text", "subtitle"],
      control: ["interrupt", "session_attach"],
      safety: [],
    },
  }));
});

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "hello.ack") {
    channel = {
      sessionId: message.sessionId,
      channelId: message.channelId,
      satelliteId: message.satelliteId,
    };
    if (!sentInput) {
      sentInput = true;
      socket.send(JSON.stringify({
        type: "user.text",
        text,
        interrupt: true,
      }));
    }
    return;
  }
  if (message.type === "message" && message.data?.role === "assistant") {
    assistantText = message.data.final
      ? message.data.content
      : `${assistantText}${message.data.content}`;
    if (message.data.final) {
      clearTimeout(timeout);
      console.log(JSON.stringify({
        channel,
        assistantText: assistantText.trim(),
        elapsedMs: Date.now() - startedAt,
      }, null, 2));
      socket.close();
    }
    return;
  }
  if (message.type === "error-event") {
    clearTimeout(timeout);
    console.error(JSON.stringify(message, null, 2));
    socket.close();
    process.exit(1);
  }
});

socket.on("close", () => {
  clearTimeout(timeout);
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
