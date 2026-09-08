import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCompanionBrowserConfig } from "./companion-browser-config.js";

test("browser config loads exact origins and separate owner-only credential files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-browser-config-"));
  const prior = process.env.HUB_COMPANION_UI_CONFIG_PATH;
  try {
    const secret = path.join(root, "credential");
    fs.writeFileSync(secret, "synthetic-enrollment-secret\n", { mode: 0o600 });
    const config = { schemaVersion: 1, canonicalOrigin: "https://fleet.example.test",
      gatewayOrigin: "https://gateway.example.test", deviceCredentialFiles: [secret],
      guestMode: "disabled",
      maxFrameBytes: 1048576, maxBufferedBytes: 2097152, maxConnections: 8,
      handshakeTimeoutMs: 1000, enrollmentPollMs: 1000 };
    process.env.HUB_COMPANION_UI_CONFIG_PATH = "browser.json";
    const write = (value: unknown) => fs.writeFileSync(path.join(root, "browser.json"), JSON.stringify(value));
    write(config);
    assert.deepEqual(loadCompanionBrowserConfig(root)?.deviceCredentials, ["synthetic-enrollment-secret"]);
    fs.chmodSync(secret, 0o644);
    assert.throws(() => loadCompanionBrowserConfig(root), /owner-only/u);
    fs.chmodSync(secret, 0o600);
    for (const invalid of [
      { ...config, gatewayOrigin: "http://gateway.example.test" },
      { ...config, canonicalOrigin: "https://fleet.example.test/" },
      { ...config, maxConnections: 0 },
      { ...config, deviceCredentialFiles: [] },
      { ...config, deviceCredentialFiles: ["relative-secret"] },
      { ...config, deviceId: "browser-supplied" },
    ]) {
      write(invalid);
      assert.throws(() => loadCompanionBrowserConfig(root));
    }
  } finally {
    if (prior === undefined) delete process.env.HUB_COMPANION_UI_CONFIG_PATH;
    else process.env.HUB_COMPANION_UI_CONFIG_PATH = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
