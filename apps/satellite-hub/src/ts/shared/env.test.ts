import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
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
  "PSFN_VOICE_REPLY_DEADLINE_MS",
  "PSFN_VOICE_ATTEMPT_TIMEOUT_MS",
  "PSFN_TEXT_REPLY_DEADLINE_MS",
  "PSFN_TEXT_ATTEMPT_TIMEOUT_MS",
] as const;

const HUB_ENV_KEYS = [
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
  "PSFN_SATELLITE_ID",
  "PSFN_ENDPOINT_ID",
  "PSFN_CLAIM_TYPE",
  "PSFN_VOICE_REPLY_DEADLINE_MS",
  "PSFN_VOICE_ATTEMPT_TIMEOUT_MS",
  "PSFN_TEXT_REPLY_DEADLINE_MS",
  "PSFN_TEXT_ATTEMPT_TIMEOUT_MS",
  "PSFN_COMPANION_BASE_URL",
  "PSFN_COMPANION_API_KEY",
  "PSFN_COMPANION_PREVIEW_MAX_BYTES",
  "PSFN_COMPANION_RECONNECT_BASE_MS",
  "PSFN_COMPANION_RECONNECT_MAX_MS",
  "HOME_ASSISTANT_ENABLED",
  "HOME_ASSISTANT_BASE_URL",
  "HOME_ASSISTANT_TOKEN",
  "HOME_ASSISTANT_RECONNECT_BASE_MS",
  "HOME_ASSISTANT_RECONNECT_MAX_MS",
  "HOME_ASSISTANT_REQUEST_TIMEOUT_MS",
  "HUB_CONTROL_BIND_HOST",
  "HUB_CONTROL_PORT",
  "HUB_CONTROL_TOKEN",
  "HUB_CONTROL_MAX_BODY_BYTES",
  "HUB_DEVICE_REGISTRY_PATH",
  "HUB_LOCATION_CONFIG_PATH",
  "EIDOVERSE_PLACE_MAP_PATH",
  "HUB_DEVICE_ASSERTION_ISSUER",
  "HUB_DEVICE_ASSERTION_KID",
  "HUB_DEVICE_ASSERTION_AUDIENCE",
  "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
  "HUB_DEVICE_ASSERTION_TTL_SECONDS",
] as const;

const HUB_ASSERTION_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN", "base64"),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" }).toString();

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
    assert.equal(runtime.voiceReplyDeadlineMs, 8_000);
    assert.equal(runtime.voiceAttemptTimeoutMs, 6_000);
    assert.equal(runtime.textReplyDeadlineMs, 80_000);
    assert.equal(runtime.textAttemptTimeoutMs, 75_000);
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

test("loadPsfnRuntime accepts world-avatar and rejects unknown capability profiles", () => {
  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_CAPABILITY_PROFILE: "world-avatar",
    PSFN_SATELLITE_ID: "eidoverse-world",
    PSFN_ENDPOINT_ID: "eidoverse-avatar",
  }, () => {
    const runtime = loadPsfnRuntime(process.cwd());
    assert.equal(runtime.satelliteClaim.capabilityProfile, "world-avatar");
    assert.equal(runtime.satelliteClaim.type, "world-avatar");
    assert.equal(runtime.satelliteClaim.endpointClass, "avatar");
  });

  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_CAPABILITY_PROFILE: "unknown-avatar",
  }, () => {
    assert.throws(
      () => loadPsfnRuntime(process.cwd()),
      /PSFN_CAPABILITY_PROFILE must be one of:.*world-avatar/,
    );
  });
});

test("loadPsfnRuntime separates strictly validated voice and text reply budgets", () => {
  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_VOICE_REPLY_DEADLINE_MS: "9000",
    PSFN_VOICE_ATTEMPT_TIMEOUT_MS: "7000",
    PSFN_TEXT_REPLY_DEADLINE_MS: "80000",
    PSFN_TEXT_ATTEMPT_TIMEOUT_MS: "75000",
  }, () => {
    const runtime = loadPsfnRuntime(process.cwd());
    assert.deepEqual({
      voiceReplyDeadlineMs: runtime.voiceReplyDeadlineMs,
      voiceAttemptTimeoutMs: runtime.voiceAttemptTimeoutMs,
      textReplyDeadlineMs: runtime.textReplyDeadlineMs,
      textAttemptTimeoutMs: runtime.textAttemptTimeoutMs,
    }, {
      voiceReplyDeadlineMs: 9_000,
      voiceAttemptTimeoutMs: 7_000,
      textReplyDeadlineMs: 80_000,
      textAttemptTimeoutMs: 75_000,
    });
  });
});

test("loadPsfnRuntime fails closed on malformed or contradictory reply budgets", () => {
  const invalidValues = ["0", "-1", "1.5", "1000ms", "9007199254740992"];
  for (const invalidValue of invalidValues) {
    withPsfnEnv({
      PSFN_API_BASE_URL: "https://psfn.example/v1",
      PSFN_TEXT_REPLY_DEADLINE_MS: invalidValue,
      PSFN_TEXT_ATTEMPT_TIMEOUT_MS: "1",
    }, () => {
      assert.throws(
        () => loadPsfnRuntime(process.cwd()),
        /PSFN_TEXT_REPLY_DEADLINE_MS must be a positive (?:safe )?integer/,
      );
    });
  }

  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_VOICE_REPLY_DEADLINE_MS: "2147483648",
    PSFN_VOICE_ATTEMPT_TIMEOUT_MS: "1",
  }, () => {
    assert.throws(
      () => loadPsfnRuntime(process.cwd()),
      /PSFN_VOICE_REPLY_DEADLINE_MS must not exceed 2147483647 ms/,
    );
  });

  for (const oneSidedConfig of [
    { PSFN_VOICE_REPLY_DEADLINE_MS: "8000" },
    { PSFN_VOICE_ATTEMPT_TIMEOUT_MS: "6000" },
    { PSFN_TEXT_REPLY_DEADLINE_MS: "80000" },
    { PSFN_TEXT_ATTEMPT_TIMEOUT_MS: "75000" },
  ]) {
    withPsfnEnv({
      PSFN_API_BASE_URL: "https://psfn.example/v1",
      ...oneSidedConfig,
    }, () => {
      assert.throws(
        () => loadPsfnRuntime(process.cwd()),
        /PSFN_(?:VOICE|TEXT)_REPLY_DEADLINE_MS and PSFN_(?:VOICE|TEXT)_ATTEMPT_TIMEOUT_MS must be configured together/,
      );
    });
  }

  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_TEXT_REPLY_DEADLINE_MS: "80001",
    PSFN_TEXT_ATTEMPT_TIMEOUT_MS: "75000",
  }, () => {
    assert.throws(
      () => loadPsfnRuntime(process.cwd()),
      /PSFN_TEXT_REPLY_DEADLINE_MS must not exceed 80000 ms/,
    );
  });

  withPsfnEnv({
    PSFN_API_BASE_URL: "https://psfn.example/v1",
    PSFN_TEXT_REPLY_DEADLINE_MS: "1000",
    PSFN_TEXT_ATTEMPT_TIMEOUT_MS: "1001",
  }, () => {
    assert.throws(
      () => loadPsfnRuntime(process.cwd()),
      /PSFN_TEXT_ATTEMPT_TIMEOUT_MS must be less than or equal to PSFN_TEXT_REPLY_DEADLINE_MS/,
    );
  });
});

test("loadHubConfig supports text-only mode without voice provider secrets", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    REALTIME_VOICE_BIND_HOST: "0.0.0.0",
    REALTIME_VOICE_PORT: "8787",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_MODEL: "companion",
    PSFN_CAPABILITY_PROFILE: "text-only",
  }, () => {
    const config = loadHubConfig(projectRoot);

    assert.equal(config.textOnlyMode, true);
    assert.equal(config.deepgramApiKey, null);
    assert.equal(config.elevenlabsApiKey, null);
    assert.equal(config.elevenlabsVoiceId, null);
    assert.equal(config.psfn.baseUrl, "http://127.0.0.1:10053/v1");
    assert.equal(config.companion, null);
    assert.equal(config.homeAssistant, null);
    assert.equal(config.control, null);
    assert.equal(config.eidoversePlaceMap, null);
    assert.equal(config.location, null);
  });
});

test("loadHubConfig loads the Hub-owned Eidoverse place map", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));
  fs.writeFileSync(path.join(projectRoot, "eidoverse-place-map.json"), JSON.stringify({
    schemaVersion: 1,
    worlds: {
      "demo-world": {
        placeId: "eidoverse:demo-world",
        regions: { market: "eidoverse:demo-world:market" },
      },
    },
  }));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    EIDOVERSE_PLACE_MAP_PATH: "eidoverse-place-map.json",
  }, () => {
    const config = loadHubConfig(projectRoot);

    assert.equal(
      config.eidoversePlaceMap?.worlds["demo-world"]?.regions.market,
      "eidoverse:demo-world:market",
    );
  });
});

test("loadHubConfig loads paired Home Assistant and private control config", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));
  fs.writeFileSync(path.join(projectRoot, "hub-assertion.key"), HUB_ASSERTION_PRIVATE_KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, "devices.json"), JSON.stringify({
    schemaVersion: 1,
    devices: [{
      deviceId: "bedroom-pi",
      deviceName: "Bedroom Pi",
      satelliteId: "bedroom",
      satelliteName: "Bedroom",
      endpointId: "bedroom-pi",
      claimType: "room-satellite",
      credentialSha256: "d8e7fca2dc7d6155537b49964e4b01c8b5d4c7fd18d75e1376e1e0f8f460f7a5",
      enrollmentVersion: 1,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "bedroom",
      maxCapabilities: { input: ["text"], output: ["text"], control: [], safety: ["local_only"] },
    }],
  }));
  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    HOME_ASSISTANT_ENABLED: "true",
    HOME_ASSISTANT_BASE_URL: "http://192.0.2.205:8123/",
    HOME_ASSISTANT_TOKEN: "ha-secret",
    HUB_CONTROL_BIND_HOST: "127.0.0.1",
    HUB_CONTROL_PORT: "8788",
    HUB_CONTROL_TOKEN: "0123456789abcdef",
    HUB_DEVICE_REGISTRY_PATH: "devices.json",
    HUB_DEVICE_ASSERTION_ISSUER: "psfn-satellite-hub",
    HUB_DEVICE_ASSERTION_KID: "hub-test",
    HUB_DEVICE_ASSERTION_AUDIENCE: "https://fleet.example.test",
    HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH: "hub-assertion.key",
    HUB_DEVICE_ASSERTION_TTL_SECONDS: "30",
  }, () => {
    const config = loadHubConfig(projectRoot);
    assert.equal(config.homeAssistant?.baseUrl, "http://192.0.2.205:8123");
    assert.equal(config.homeAssistant?.token, "ha-secret");
    assert.equal(config.control?.bindHost, "127.0.0.1");
    assert.equal(config.control?.port, 8788);
    assert.ok(config.psfn.deviceAssertionIssuer);
    assert.equal(config.deviceRegistry?.readCurrent().devices[0]?.enrollmentVersion, 1);
    const registryPath = path.join(projectRoot, "devices.json");
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      schemaVersion: 1;
      devices: Array<Record<string, unknown>>;
    };
    updated.devices[0]!.enrollmentVersion = 2;
    fs.writeFileSync(registryPath, JSON.stringify(updated));
    assert.equal(config.deviceRegistry?.readCurrent().devices[0]?.enrollmentVersion, 2);

    updated.devices[0]!.credentialSha256 = createHash("sha256")
      .update("0123456789abcdef")
      .digest("hex");
    fs.writeFileSync(registryPath, JSON.stringify(updated));
    assert.throws(
      () => config.deviceRegistry?.readCurrent(),
      /HUB_CONTROL_TOKEN must not match a registered device credential/,
    );

    updated.devices[0]!.credentialSha256 = createHash("sha256")
      .update("replacement-device-credential")
      .digest("hex");
    updated.devices[0]!.enrollmentVersion = 3;
    fs.writeFileSync(registryPath, JSON.stringify(updated));
    assert.equal(config.deviceRegistry?.readCurrent().devices[0]?.enrollmentVersion, 3);
  });
});

test("loadHubConfig fails closed when an enrolled registry lacks complete signing authority", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));
  fs.writeFileSync(path.join(projectRoot, "devices.json"), JSON.stringify({
    schemaVersion: 1,
    devices: [{
      deviceId: "office-device", deviceName: "Office", satelliteId: "office",
      satelliteName: "Office", endpointId: "office-device", claimType: "room-satellite",
      credentialSha256: "0".repeat(64), enrollmentVersion: 1,
      enrollmentAssurance: "device_credential", enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111", placeId: "office",
      maxCapabilities: { input: [], output: [], control: [], safety: [] },
    }],
  }));
  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    HUB_DEVICE_REGISTRY_PATH: "devices.json",
  }, () => {
    assert.throws(() => loadHubConfig(projectRoot), /requires complete Hub device assertion signing authority/);
  });
});

test("loadHubConfig rejects enabled Home Assistant without the private control plane", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));
  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    HOME_ASSISTANT_ENABLED: "true",
    HOME_ASSISTANT_BASE_URL: "http://192.0.2.205:8123",
    HOME_ASSISTANT_TOKEN: "ha-secret",
  }, () => {
    assert.throws(
      () => loadHubConfig(projectRoot),
      /HUB_CONTROL_BIND_HOST, HUB_CONTROL_PORT, and HUB_CONTROL_TOKEN must all be set/,
    );
  });
});

test("loadHubConfig loads the companion bridge config with PSFN auth fallback", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_API_KEY: "psfn-key",
    PSFN_CAPABILITY_PROFILE: "text-only",
    PSFN_SATELLITE_ID: "hub-main",
    PSFN_ENDPOINT_ID: "hub-endpoint",
    PSFN_CLAIM_TYPE: "companion-hub",
    PSFN_COMPANION_BASE_URL: "http://127.0.0.1:10053/v1/",
    PSFN_COMPANION_PREVIEW_MAX_BYTES: "2048",
  }, () => {
    const config = loadHubConfig(projectRoot);

    assert.equal(config.companion?.baseUrl, "http://127.0.0.1:10053/v1");
    assert.equal(config.companion?.apiKey, "psfn-key");
    assert.deepEqual(config.companion?.identity, {
      satelliteId: "hub-main",
      endpointId: "hub-endpoint",
      claimType: "companion-hub",
    });
    assert.equal(config.companion?.previewMaxBytes, 2048);
    assert.equal(config.companion?.reconnectBaseMs, 1000);
    assert.equal(config.companion?.reconnectMaxMs, 30000);
  });
});

test("loadHubConfig reuses the satellite claim identity defaults for the companion bridge", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_COMPANION_BASE_URL: "http://127.0.0.1:10053/v1",
  }, () => {
    const config = loadHubConfig(projectRoot);
    assert.deepEqual(config.companion?.identity, {
      satelliteId: config.psfn.satelliteClaim.satelliteId,
      endpointId: config.psfn.satelliteClaim.endpointId,
      claimType: config.psfn.satelliteClaim.type,
    });
  });
});

test("loadHubConfig prefers the explicit companion API key over the PSFN key", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_API_KEY: "psfn-key",
    PSFN_COMPANION_BASE_URL: "http://127.0.0.1:10054",
    PSFN_COMPANION_API_KEY: "companion-key",
  }, () => {
    const config = loadHubConfig(projectRoot);
    assert.equal(config.companion?.apiKey, "companion-key");
  });
});

test("loadHubConfig rejects invalid companion preview size caps", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-hub-runtime-"));

  withEnv(HUB_ENV_KEYS, {
    HUB_TEXT_ONLY: "true",
    PSFN_API_BASE_URL: "http://127.0.0.1:10053/v1",
    PSFN_COMPANION_BASE_URL: "http://127.0.0.1:10054",
    PSFN_COMPANION_PREVIEW_MAX_BYTES: "0",
  }, () => {
    assert.throws(
      () => loadHubConfig(projectRoot),
      /PSFN_COMPANION_PREVIEW_MAX_BYTES must be a positive integer/,
    );
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
