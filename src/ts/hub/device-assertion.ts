import {
  createPrivateKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import type { HubDeviceIdentity } from "./device-registry.js";

export type HubDeviceAssertionAuthority = Pick<
  HubDeviceIdentity,
  | "deviceId"
  | "enrollmentVersion"
  | "enrollmentAssurance"
  | "enrollmentStatus"
  | "companionId"
  | "placeId"
>;

export const HUB_DEVICE_ASSERTION_HEADER = {
  alg: "EdDSA",
  typ: "PSFN-HUB-DEVICE",
  v: 1,
} as const;

export interface HubDeviceAssertionIssuerConfig {
  issuer: string;
  kid: string;
  audience: string;
  privateKeyPem: string;
  ttlSeconds: number;
}

export interface IssueHubDeviceAssertionInput {
  device: HubDeviceAssertionAuthority;
  sessionId: string;
  issuedAtSeconds?: number;
  jti?: string;
}

export interface HubDeviceAssertionIssuer {
  issue(input: IssueHubDeviceAssertionInput): string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const JTI_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createHubDeviceAssertionIssuer(
  config: HubDeviceAssertionIssuerConfig,
): HubDeviceAssertionIssuer {
  const issuer = requireStableId(config.issuer, "Hub device assertion issuer");
  const kid = requireStableId(config.kid, "Hub device assertion key id");
  const audience = requireExactHttpsOrigin(config.audience);
  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 5 || config.ttlSeconds > 60) {
    throw new Error("Hub device assertion TTL must be an integer between 5 and 60 seconds");
  }
  const privateKey = parsePrivateKey(config.privateKeyPem);

  return Object.freeze({
    issue(input: IssueHubDeviceAssertionInput): string {
      if (input.device.enrollmentStatus !== "active") {
        throw new Error("Hub device assertions require an active device enrollment");
      }
      const sessionId = requireToken(input.sessionId, "Hub device assertion session id");
      const deviceId = requireToken(input.device.deviceId, "Hub device assertion device id");
      const companionId = requireUuid(input.device.companionId, "Hub device assertion companion id");
      if (!Number.isSafeInteger(input.device.enrollmentVersion) || input.device.enrollmentVersion < 1) {
        throw new Error("Hub device assertion enrollment version must be a positive integer");
      }
      if (input.device.enrollmentAssurance !== "device_credential") {
        throw new Error("Hub device assertion enrollment assurance is unsupported");
      }
      const placeId = input.device.placeId
        ? requireToken(input.device.placeId, "Hub device assertion place id")
        : undefined;
      const issuedAtSeconds = input.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 1) {
        throw new Error("Hub device assertion issued-at must be a positive integer");
      }
      const jti = input.jti ?? randomUUID();
      if (!JTI_PATTERN.test(jti)) {
        throw new Error("Hub device assertion jti must be a lowercase RFC-4122 UUID");
      }
      const header = { ...HUB_DEVICE_ASSERTION_HEADER, kid };
      const claims = {
        iss: issuer,
        device_id: deviceId,
        enrollment_version: input.device.enrollmentVersion,
        enrollment_assurance: input.device.enrollmentAssurance,
        ...(placeId ? { place_id: placeId } : {}),
        aud: audience,
        companion_id: companionId,
        session_id: sessionId,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + config.ttlSeconds,
        jti,
      };
      const encodedHeader = encodeCanonicalJson(header);
      const encodedClaims = encodeCanonicalJson(claims);
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const signature = sign(null, Buffer.from(signingInput, "ascii"), privateKey);
      return `${signingInput}.${signature.toString("base64url")}`;
    },
  });
}

function requireUuid(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error(`${field} must be a lowercase RFC-4122 UUID`);
  }
  return normalized;
}

function parsePrivateKey(value: string): KeyObject {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return key;
  } catch {
    throw new Error("Hub device assertion private key must be an Ed25519 private key");
  }
}

function requireToken(value: string, field: string): string {
  const normalized = value.trim();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${field} has an invalid format`);
  }
  return normalized;
}

function requireStableId(value: string, field: string): string {
  const normalized = value.trim();
  if (!STABLE_ID_PATTERN.test(normalized) || normalized !== value) {
    throw new Error(`${field} must use stable identifier characters`);
  }
  return normalized;
}

function requireExactHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Hub device assertion audience must be an exact normalized HTTPS origin");
  }
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || value.endsWith("/")
    || value !== parsed.origin) {
    throw new Error("Hub device assertion audience must be an exact normalized HTTPS origin");
  }
  return parsed.origin;
}

function encodeCanonicalJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
