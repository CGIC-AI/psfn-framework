import fs from "node:fs";
import path from "node:path";

export interface CompanionBrowserConfig {
  canonicalOrigin: string;
  gatewayOrigin: string;
  guestMode: "disabled" | "explicit";
  deviceCredentials: readonly string[];
  maxFrameBytes: number;
  maxBufferedBytes: number;
  maxConnections: number;
  handshakeTimeoutMs: number;
  enrollmentPollMs: number;
}

/** Explicit deployment wiring; credentials are read from separate secret files. */
export function loadCompanionBrowserConfig(projectRoot: string): CompanionBrowserConfig | null {
  const filename = process.env.HUB_COMPANION_UI_CONFIG_PATH?.trim();
  if (!filename) return null;
  const value: unknown = JSON.parse(fs.readFileSync(path.resolve(projectRoot, filename), "utf8"));
  if (!record(value) || Object.keys(value).sort().join(",") !== [
    "schemaVersion", "canonicalOrigin", "gatewayOrigin", "guestMode", "deviceCredentialFiles",
    "maxFrameBytes", "maxBufferedBytes", "maxConnections", "handshakeTimeoutMs", "enrollmentPollMs",
  ].sort().join(",") || value.schemaVersion !== 1
    || (value.guestMode !== "disabled" && value.guestMode !== "explicit")
    || !Array.isArray(value.deviceCredentialFiles) || value.deviceCredentialFiles.length === 0) {
    throw new Error("Companion browser config is malformed");
  }
  const deviceCredentials = value.deviceCredentialFiles.map(file => {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      throw new Error("Companion browser credentials require absolute secret-file paths");
    }
    if ((fs.statSync(file).mode & 0o077) !== 0) {
      throw new Error("Companion browser credential file must be owner-only");
    }
    const credential = fs.readFileSync(file, "utf8").trim();
    if (!credential || /[\r\n]/u.test(credential)) throw new Error("Invalid companion browser credential");
    return credential;
  });
  const config: CompanionBrowserConfig = {
    canonicalOrigin: exactHttpsOrigin(value.canonicalOrigin),
    gatewayOrigin: exactHttpsOrigin(value.gatewayOrigin),
    guestMode: value.guestMode,
    deviceCredentials,
    maxFrameBytes: positive(value.maxFrameBytes),
    maxBufferedBytes: positive(value.maxBufferedBytes),
    maxConnections: positive(value.maxConnections),
    handshakeTimeoutMs: positive(value.handshakeTimeoutMs),
    enrollmentPollMs: positive(value.enrollmentPollMs),
  };
  return config;
}

export function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Companion browser origin is required");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Companion browser origin must be one exact HTTPS origin");
  }
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
    throw new Error("Companion browser limits must be positive bounded integers");
  }
  return Number(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
