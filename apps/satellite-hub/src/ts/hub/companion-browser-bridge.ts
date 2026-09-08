import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type ClientOptions, type RawData } from "ws";
import type { PsfnRuntimeConfig } from "../shared/env.js";
import type { HubDeviceRegistryAuthority } from "./device-registry.js";
import { exactHttpsOrigin, type CompanionBrowserConfig } from "./companion-browser-config.js";
import {
  admitBrowserRequest, assertionRenewalDelay, browserGatewayHeaders,
  issueBrowserRenewal, resolveBrowserDevices,
} from "./companion-browser-authority.js";
import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { CompanionBrowserSpeech } from "./companion-browser-speech.js";

export class CompanionBrowserBridge {
  private readonly server: WebSocketServer;
  private readonly connections = new Set<() => void>();
  private readonly pendingUpstreams = new Set<WebSocket>();
  private pendingConnections = 0;
  private stopped = false;

  constructor(private readonly config: CompanionBrowserConfig,
    private readonly runtime: PsfnRuntimeConfig,
    private readonly registry: HubDeviceRegistryAuthority,
    private readonly tts: StreamingTtsAdapter | null,
    private readonly connectGateway = (url: string, options: ClientOptions) => new WebSocket(url, options)) {
    exactHttpsOrigin(config.canonicalOrigin);
    exactHttpsOrigin(config.gatewayOrigin);
    if (!runtime.apiKey || !runtime.deviceAssertionIssuer) {
      throw new Error("Companion browser bridge requires Hub API and assertion authority");
    }
    resolveBrowserDevices(config, registry);
    this.server = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes, perMessageDeflate: false });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!(request.url ?? "").startsWith("/companion-ui/")) return false;
    try {
      if (this.stopped) throw new Error("Companion browser bridge stopped");
      const companionId = admitBrowserRequest(request, this.config);
      const device = resolveBrowserDevices(this.config, this.registry, false).get(companionId);
      if (!device || this.connections.size + this.pendingConnections >= this.config.maxConnections) {
        throw new Error("Companion browser endpoint unavailable");
      }
      const sessionId = `companion-ui:${randomUUID()}`;
      const issuer = this.runtime.deviceAssertionIssuer!;
      const headers = browserGatewayHeaders({ config: this.config, device, sessionId,
        cookie: request.headers.cookie!, apiKey: this.runtime.apiKey!, issuer, spokenAudio: this.tts !== null });
      const tls = this.runtime.satelliteClaim.tls;
      const upstream = this.connectGateway(
        `${this.config.gatewayOrigin.replace(/^https:/u, "wss:")}${request.url}`,
        { headers, maxPayload: this.config.maxFrameBytes, perMessageDeflate: false,
          handshakeTimeout: this.config.handshakeTimeoutMs,
          ...(tls?.certPath ? { cert: fs.readFileSync(tls.certPath) } : {}),
          ...(tls?.keyPath ? { key: fs.readFileSync(tls.keyPath) } : {}),
          ...(tls?.caPath ? { ca: fs.readFileSync(tls.caPath) } : {}) },
      );
      this.pendingConnections += 1;
      this.pendingUpstreams.add(upstream);
      let admitted = false;
      const deny = () => {
        this.pendingUpstreams.delete(upstream);
        if (!admitted) { admitted = true; this.pendingConnections -= 1; reject(socket); }
      };
      upstream.once("error", deny);
      upstream.once("close", deny);
      socket.once("close", () => { upstream.terminate(); deny(); });
      upstream.once("open", () => {
        this.pendingUpstreams.delete(upstream);
        if (admitted || socket.destroyed || this.stopped) { upstream.terminate(); return; }
        admitted = true;
        this.pendingConnections -= 1;
        this.server.handleUpgrade(request, socket, head, browser => {
          const deviceKey = JSON.stringify(device);
          const assertEnrollment = () => {
            const current = resolveBrowserDevices(this.config, this.registry, false).get(companionId);
            if (!current || JSON.stringify(current) !== deviceKey) throw new Error("Hub enrollment changed");
          };
          this.attach(browser, upstream, assertEnrollment,
            () => issueBrowserRenewal(issuer, device, sessionId),
            assertionRenewalDelay(headers["X-PSFN-Hub-Device-Assertion"]!));
        });
      });
    } catch { reject(socket); }
    return true;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const upstream of this.pendingUpstreams) upstream.terminate();
    for (const close of this.connections) close();
    for (const browser of this.server.clients) browser.terminate();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private attach(browser: WebSocket, upstream: WebSocket, assertEnrollment: () => void,
    renewal: () => ReturnType<typeof issueBrowserRenewal>, renewalDelay: number): void {
    let closed = false;
    let configured = false;
    let renewalId: string | null = null;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(enrollmentTimer);
      clearTimeout(renewalTimer);
      speech.stop(false);
      browser.close(4401, "Companion connection closed");
      upstream.close(1000);
    };
    const send = (socket: WebSocket, data: RawData | string, binary: boolean) => {
      if (closed) return;
      assertEnrollment();
      const length = typeof data === "string" ? Buffer.byteLength(data)
        : Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
      if (socket.readyState !== WebSocket.OPEN || length > this.config.maxFrameBytes
        || socket.bufferedAmount + length > this.config.maxBufferedBytes) {
        close();
        return;
      }
      socket.send(data, { binary }, error => { if (error) close(); });
    };
    const speech = new CompanionBrowserSpeech(this.tts, value => {
      try { send(browser, JSON.stringify(value), false); } catch { close(); }
    });
    const scheduleRenewal = () => {
      clearTimeout(renewalTimer);
      renewalTimer = setTimeout(() => {
        try {
          if (renewalId) { close(); return; }
          const frame = renewal();
          renewalId = frame.requestId;
          send(upstream, JSON.stringify(frame), false);
          scheduleRenewal();
        } catch { close(); }
      }, renewalDelay);
      renewalTimer.unref();
    };
    const enrollmentTimer = setInterval(() => {
      try { assertEnrollment(); } catch { close(); }
    }, this.config.enrollmentPollMs);
    enrollmentTimer.unref();
    this.connections.add(close);
    browser.on("message", (data, binary) => {
      try {
        if (binary) {
          if (!configured) throw new Error("Browser not configured");
        } else {
          const value = parseObject(data);
          // The gateway's privileged control family never crosses browser ingress.
          if (typeof value.type === "string" && value.type.startsWith("hub.")) throw new Error("Server control forbidden");
          if (Object.hasOwn(value, "assertion")) throw new Error("Browser authority forbidden");
          speech.observeBrowser(value);
        }
        send(upstream, data, binary);
      } catch { close(); }
    });
    upstream.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Unexpected gateway binary output");
        const value = parseObject(data);
        if (value.type === "hub.session.renewed") {
          if (value.schemaVersion !== 1 || value.requestId !== renewalId || !renewalId
            || Object.keys(value).length !== 3) throw new Error("Unexpected renewal receipt");
          renewalId = null;
          scheduleRenewal();
          return;
        }
        if (typeof value.type !== "string" || value.type.startsWith("hub.")
          || Object.hasOwn(value, "assertion")) throw new Error("Unexpected gateway control");
        if (value.type === "session.ready") {
          if (configured) throw new Error("Repeated gateway attachment");
          configured = true;
          scheduleRenewal();
        }
        send(browser, data, false);
        if (!closed) speech.observeGateway(value);
      } catch { close(); }
    });
    browser.once("close", () => { this.connections.delete(close); close(); });
    browser.once("error", close);
    upstream.once("close", close);
    upstream.once("error", close);
  }
}

function parseObject(data: RawData): Record<string, unknown> {
  const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid frame");
  return value as Record<string, unknown>;
}

function reject(socket: Duplex): void {
  if (socket.destroyed) return;
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
