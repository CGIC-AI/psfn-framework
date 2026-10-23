import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";

import type { HubConfig } from "../shared/env.js";
import { authenticateHubDevice, requireCurrentHubDeviceEnrollment, type HubDeviceIdentity } from "./device-registry.js";

export interface HubAccessConfig {
  developerMode: boolean;
  allowedOrigins: string[];
  voxtaToken?: string;
}

export interface HubPrincipal {
  id: string;
  device?: HubDeviceIdentity;
}

/** One authority for native credentials, browser origins and local development. */
export class HubAccess {
  private readonly realtimeSessions = new Map<string, string>();
  constructor(private readonly config: HubConfig) {
    if (config.voxta.sessionId || config.voxta.chatId) {
      throw new Error("Remove VOXTA_SESSION_ID and VOXTA_CHAT_ID: authenticated sessions are allocated by the Hub");
    }
    if (config.access?.developerMode && !isLoopback(config.bindHost)) {
      throw new Error("HUB_DEVELOPER_MODE requires a literal loopback bind address");
    }
    for (const origin of config.access?.allowedOrigins ?? []) {
      if (!isWebOrigin(origin)) throw new Error("HUB_ALLOWED_ORIGINS requires exact http(s) origins");
    }
    const token = config.access?.voxtaToken;
    if (token !== undefined) {
      if (!/^[A-Za-z0-9_-]{43,}$/u.test(token)) {
        throw new Error("VOXTA_AUTH_TOKEN must contain at least 43 base64url characters (32 random bytes)");
      }
      const reserved = [config.psfn.apiKey, config.companion?.apiKey, config.control?.token,
        config.deepgramApiKey, config.elevenlabsApiKey, config.homeAssistant?.token];
      if (reserved.some(value => value && sameCredential(value, token))) {
        throw new Error("VOXTA_AUTH_TOKEN must be dedicated and must not reuse another service credential");
      }
      this.assertDedicatedToken();
    }
    if (!isLoopback(config.bindHost) && !config.deviceRegistry && !(config.voxta.enabled && token)) {
      throw new Error("Non-loopback Hub requires enrolled device authority or a dedicated Voxta credential");
    }
  }

  originAllowed(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    return origin === undefined || (this.config.access?.allowedOrigins ?? []).includes(origin);
  }

  writeCors(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.setHeader("Vary", "Origin");
    if (request.headers.origin && this.originAllowed(request)) {
      response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    }
  }

  developerAllowed(request: http.IncomingMessage): boolean {
    return this.config.access?.developerMode === true
      && isLoopback(this.config.bindHost)
      && isLoopback(request.socket.remoteAddress ?? "");
  }

  verifyDevice(credential: string | undefined): HubDeviceIdentity | null {
    this.assertDedicatedToken();
    return this.config.deviceRegistry
      ? authenticateHubDevice(this.config.deviceRegistry.readCurrent(), credential)
      : null;
  }

  authenticate(request: http.IncomingMessage): HubPrincipal | null {
    if (!this.originAllowed(request) || hasQueryCredential(request)) return null;
    const header = request.headers.authorization;
    if (header === undefined && this.developerAllowed(request)) return { id: "loopback-development" };
    const match = /^Bearer ([^\s]+)$/u.exec(header ?? "");
    if (!match) return null;
    try {
      const token = this.config.access?.voxtaToken;
      this.assertDedicatedToken();
      if (token && sameCredential(match[1]!, token)) return { id: "voxta-dedicated" };
      const device = this.verifyDevice(match[1]);
      return device ? { id: JSON.stringify(["device", device.deviceId, device.companionId, device.enrollmentVersion]), device } : null;
    } catch {
      return null;
    }
  }

  assertCurrent(principal: HubPrincipal): void {
    this.assertDedicatedToken();
    if (principal.device) {
      if (!this.config.deviceRegistry) throw new Error("Hub device authority unavailable");
      const current = requireCurrentHubDeviceEnrollment(this.config.deviceRegistry, principal.device);
      if (JSON.stringify(current) !== JSON.stringify(principal.device)) throw new Error("Hub device authority changed");
    }
  }

  realtimeSession(device: HubDeviceIdentity, requested: string | undefined): string {
    const key = JSON.stringify([device.deviceId, device.companionId, device.enrollmentVersion, requested?.trim() || null]);
    let session = this.realtimeSessions.get(key);
    if (!session) {
      session = `realtime:${randomUUID()}`;
      this.realtimeSessions.set(key, session);
    }
    return session;
  }

  allowRealtimeUpgrade(request: http.IncomingMessage): boolean {
    // Enrolled realtime clients authenticate in hello before attaching a session.
    return this.originAllowed(request) && !hasQueryCredential(request)
      && (this.config.deviceRegistry !== null || this.developerAllowed(request));
  }

  private assertDedicatedToken(): void {
    const token = this.config.access?.voxtaToken;
    if (token && this.config.deviceRegistry?.readCurrent().devices.some(device =>
      sameDigest(device.credentialSha256, createHash("sha256").update(token).digest("hex")))) {
      throw new Error("VOXTA_AUTH_TOKEN must not reuse an enrolled device credential");
    }
  }
}

export function rejectHubUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function hasQueryCredential(request: http.IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  return ["access_token", "token", "credential", "authorization"].some(key => url.searchParams.has(key));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

function isWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin && !origin.includes("*");
  } catch {
    return false;
  }
}

function sameCredential(left: string, right: string): boolean {
  return sameDigest(createHash("sha256").update(left).digest("hex"), createHash("sha256").update(right).digest("hex"));
}

function sameDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
