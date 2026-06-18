import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadHubConfig, loadPsfnRuntime } from "./env.js";

const PSFN_ENV_KEYS = [
  "PSFN_API_BASE_URL",
  "PSFN_API_KEY",
  "PSFN_MODEL",
  "PSFN_CLAIM_NAMESPACE",
  "PSFN_CLAIM_TYPE",
  "PSFN_CHANNEL_TYPE",
  "PSFN_CAPABILITY_PROFILE",
  "PSFN_SATELLITE_ID",
  "PSFN_ENDPOINT_ID",
  "PSFN_ENDPOINT_NAME",
  "PSFN_ENDPOINT_CLASS",
  "PSFN_LOCATION_MODE",
  "PSFN_TELEMETRY_MODE",
  "PSFN_TELEMETRY_CATEGORIES",
  "PSFN_CLIENT_CERT_PATH",
  "PSFN_CLIENT_KEY_PATH",
  "PSFN_CA_CERT_PATH",
] as const;

const HUB_ENV_KEYS = [
  "AGENT_RUNTIME",
  "HUB_TEXT_ONLY",
  "REALTIME_VOICE_BIND_HOST",
  "REALTIME_VOICE_PORT",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL_ID",
  "PSFN_API_BASE_URL",
  "PSFN_API_KEY",
  "PSFN_MODEL",
  "PSFN_CAPABILITY_PROFILE",
] as const;

test("loadPsfnRuntime reads registry claim identity and certificate paths", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-runtime-"));
  fs.writeFileSync(path.join(projectRoot, "client.pem"), "client-cert");
  fs.writeFileSync(path.join(projectRoot, "client.key"), "client-key");
  fs.writeFileSync(path.join(projectRoot, "ca.pem"), "ca-cert");

  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_MODEL: "psfn",
    PSFN_CAPABILITY_PROFILE: "mobile-location",
    PSFN_SATELLITE_ID: "phone-sat",
    PSFN_ENDPOINT_ID: "phone-browser",
    PSFN_ENDPOINT_NAME: "Phone Browser",
    PSFN_TELEMETRY_CATEGORIES: "location,timezone,battery",
    PSFN_CLIENT_CERT_PATH: "client.pem",
    PSFN_CLIENT_KEY_PATH: "client.key",
    PSFN_CA_CERT_PATH: "ca.pem",
  }, () => {
    const runtime = loadPsfnRuntime(projectRoot);

    assert.equal(runtime.channelType, "satellite.endpoint");
    assert.equal(runtime.satelliteClaim.namespace, "satellite.endpoint");
    assert.equal(runtime.satelliteClaim.type, "mobile-location");
    assert.equal(runtime.satelliteClaim.satelliteId, "phone-sat");
    assert.equal(runtime.satelliteClaim.endpointId, "phone-browser");
    assert.equal(runtime.satelliteClaim.endpointClass, "mobile");
    assert.equal(runtime.satelliteClaim.locationMode, "mobile");
    assert.deepEqual(runtime.satelliteClaim.telemetry.categories, ["location", "timezone", "battery"]);
    assert.equal(runtime.satelliteClaim.tls?.certPath, path.join(projectRoot, "client.pem"));
    assert.equal(runtime.satelliteClaim.tls?.keyPath, path.join(projectRoot, "client.key"));
    assert.equal(runtime.satelliteClaim.tls?.caPath, path.join(projectRoot, "ca.pem"));
  });
});

test("loadPsfnRuntime rejects incomplete client certificate pairs", () => {
  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_CLIENT_CERT_PATH: "client.pem",
  }, () => {
    assert.throws(
      () => loadPsfnRuntime(process.cwd()),
      /PSFN_CLIENT_CERT_PATH and PSFN_CLIENT_KEY_PATH must both be set/,
    );
  });
});

test("loadHubConfig supports text-only mode without voice provider secrets", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    AGENT_RUNTIME: "psfn",
    HUB_TEXT_ONLY: "true",
    REALTIME_VOICE_BIND_HOST: "0.0.0.0",
    REALTIME_VOICE_PORT: "8787",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_MODEL: "purrsephone",
    PSFN_CAPABILITY_PROFILE: "text-only",
  }, () => {
    const config = loadHubConfig(projectRoot);

    assert.equal(config.textOnlyMode, true);
    assert.equal(config.deepgramApiKey, null);
    assert.equal(config.elevenlabsApiKey, null);
    assert.equal(config.elevenlabsVoiceId, null);
    assert.equal(config.psfn?.baseUrl, "http://127.0.0.1:10053/v1");
  });
});

function withPsfnEnv(values: Partial<Record<(typeof PSFN_ENV_KEYS)[number], string>>, fn: () => void): void {
  withEnv(PSFN_ENV_KEYS, values, fn);
}

function withEnv<TKey extends string>(
  keys: readonly TKey[],
  values: Partial<Record<TKey, string>>,
  fn: () => void,
): void {
  const original = new Map<string, string | undefined>();
  for (const key of keys) {
    original.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
