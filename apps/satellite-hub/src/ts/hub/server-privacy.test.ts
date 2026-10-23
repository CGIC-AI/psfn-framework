import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

test("actual Hub stdout/stderr exclude private conversation sentinels while clients retain content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-privacy-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../test-support/hub-resource-child.js", import.meta.url))], {
    cwd: root, env: { ...process.env, HUB_TEST_PRIVATE_SENTINELS: "true", HUB_DEVELOPER_MODE: "true", HUB_TEXT_ONLY: "true",
      REALTIME_VOICE_BIND_HOST: "127.0.0.1", REALTIME_VOICE_PORT: "0", HUB_DEVICE_REGISTRY_PATH: "", HUB_CONTROL_TOKEN: "",
      HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH: "", HUB_DEVICE_ASSERTION_ISSUER: "", HUB_DEVICE_ASSERTION_KID: "", HUB_DEVICE_ASSERTION_AUDIENCE: "", HUB_DEVICE_ASSERTION_TTL_SECONDS: "",
      PSFN_API_BASE_URL: "http://127.0.0.1:1/v1", PSFN_API_KEY: "", PSFN_COMPANION_BASE_URL: "", HOME_ASSISTANT_ENABLED: "false",
      VOXTA_FACADE_ENABLED: "false", VOXTA_AUTH_TOKEN: "", HUB_RESOURCE_LIMITS_PATH: "", ARTIFACT_ROOT: path.join(root, "artifacts") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk.toString(); });
  child.stderr!.on("data", chunk => { output += chunk.toString(); });
  let socket: WebSocket | undefined;
  try {
    const [{ port }] = await once(child, "message") as [{ port: number }];
    socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages: string[] = [];
    socket.on("message", raw => messages.push(raw.toString()));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "user.text", text: "USER_PRIVATE_SENTINEL ATTACHMENT_PRIVATE_SENTINEL\r\n\u001b[31mINJECTED" }));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes('"final":true')); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(messages.some(message => message.includes("USER_PRIVATE_SENTINEL")));
    for (const message of [{ type: "turn.start" }, { type: "audio", audio: "AQACAA==" }, { type: "turn.end" }]) socket.send(JSON.stringify(message));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes("TRANSCRIPT_PRIVATE_SENTINEL")); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(messages.some(message => message.includes("TRANSCRIPT_PRIVATE_SENTINEL")));
    assert.doesNotMatch(output, /PRIVATE_SENTINEL|\u001b|\r/);
    assert.match(output, /reply|transcript|connected/);
  } finally {
    socket?.terminate(); const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
