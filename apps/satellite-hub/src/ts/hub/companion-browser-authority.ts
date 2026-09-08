import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HubDeviceAssertionIssuer } from "./device-assertion.js";
import {
  authenticateHubDevice,
  type HubDeviceIdentity,
  type HubDeviceRegistryAuthority,
} from "./device-registry.js";
import { frameworkCapabilitiesForSatelliteCapabilities } from "./satellite-claim.js";
import type { CompanionBrowserConfig } from "./companion-browser-config.js";

export function resolveBrowserDevices(
  config: CompanionBrowserConfig,
  registry: HubDeviceRegistryAuthority,
  requireAll = true,
): Map<string, HubDeviceIdentity> {
  const devices = new Map<string, HubDeviceIdentity>();
  const ambiguous = new Set<string>();
  const current = registry.readCurrent();
  for (const credential of config.deviceCredentials) {
    const device = authenticateHubDevice(current, credential);
    if (!device) {
      if (requireAll) throw new Error("Companion browser endpoint credential is not enrolled");
      continue;
    }
    if (devices.has(device.companionId) || ambiguous.has(device.companionId)) {
      if (requireAll) throw new Error("Companion browser binding must authenticate exactly one endpoint per companion");
      ambiguous.add(device.companionId);
      devices.delete(device.companionId);
      continue;
    }
    devices.set(device.companionId, device);
  }
  return devices;
}

export function admitBrowserRequest(request: IncomingMessage, config: CompanionBrowserConfig): string {
  const route = /^\/companion-ui\/companions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/ws$/u.exec(request.url ?? "");
  const headers = request.headers;
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
  const cookieCount = names.filter(name => name === "cookie").length;
  const validCookie = typeof headers.cookie === "string" && /^__Host-psfn_session=[A-Za-z0-9_-]{43}$/u.test(headers.cookie);
  if (!route?.[1] || request.method !== "GET"
    || headers.host !== new URL(config.canonicalOrigin).host
    || headers.origin !== config.canonicalOrigin
    || !["host", "origin"].every(name => names.filter(value => value === name).length === 1)
    || names.some(name => name === "authorization" || name === "sec-websocket-protocol"
      || name.startsWith("x-psfn-") || name.startsWith("x-identity-claim-"))
    || !(validCookie ? cookieCount === 1 : cookieCount === 0 && config.guestMode === "explicit")) {
    throw new Error("Companion browser upgrade denied");
  }
  return route[1];
}

export function browserGatewayHeaders(input: {
  config: CompanionBrowserConfig;
  device: HubDeviceIdentity;
  sessionId: string;
  cookie?: string;
  apiKey: string;
  issuer: HubDeviceAssertionIssuer;
  spokenAudio: boolean;
}): Record<string, string> {
  const { device } = input;
  const capabilities = frameworkCapabilitiesForSatelliteCapabilities(device.maxCapabilities)
    .filter(value => input.spokenAudio || (value !== "audio_output" && value !== "text_to_speech"));
  const telemetry = ["status"];
  if (device.maxCapabilities.control.includes("approvals")) telemetry.push("approvals");
  for (const [capability, scope] of [["artifact", "artifacts"], ["tool_activity", "tool_activity"], ["emotion", "emotion"]] as const) {
    if (device.maxCapabilities.output.includes(capability)) telemetry.push(scope);
  }
  return {
    Host: new URL(input.config.canonicalOrigin).host,
    Origin: input.config.canonicalOrigin,
    ...(input.cookie ? { Cookie: input.cookie } : {}),
    Authorization: `Bearer ${input.apiKey}`,
    "X-PSFN-Satellite-Claim-Type": device.claimType,
    "X-PSFN-Satellite-ID": device.satelliteId,
    "X-PSFN-Satellite-Endpoint-ID": device.endpointId,
    "X-PSFN-Satellite-Session-ID": input.sessionId,
    "X-PSFN-Satellite-Capabilities": capabilities.join(","),
    "X-PSFN-Satellite-Telemetry-Scopes": telemetry.join(","),
    "X-PSFN-Hub-Device-Assertion": input.issuer.issue({ device, sessionId: input.sessionId }),
  };
}

export function issueBrowserRenewal(issuer: HubDeviceAssertionIssuer, device: HubDeviceIdentity, sessionId: string) {
  return { schemaVersion: 1, type: "hub.session.renew", requestId: `hub-renew:${randomUUID()}`,
    assertion: issuer.issue({ device, sessionId }) };
}

export function assertionRenewalDelay(assertion: string): number {
  const claims = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat: number; exp: number };
  const delay = (claims.exp - claims.iat) * 1000 / 2;
  if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error("Invalid Hub assertion lifetime");
  return delay;
}
