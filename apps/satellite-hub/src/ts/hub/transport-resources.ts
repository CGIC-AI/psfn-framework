import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import WebSocket, { type RawData } from "ws";
import { awaitWithAbort, throwIfAborted } from "../shared/abort.js";

// Deployment admission defaults and their rationale are documented in the Hub
// README. HUB_RESOURCE_LIMITS_PATH owns overrides; tests use the same loader.
export const DEFAULT_HUB_LIMITS = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxHttpBodyBytes: 64 * 1024,
  maxVisionBodyBytes: 4 * 1024 * 1024 + 64 * 1024,
  maxVisionFileBytes: 4 * 1024 * 1024,
  maxAudioBytes: 4 * 1024 * 1024,
  maxAudioDurationMs: 120_000,
  maxPendingNegotiations: 128,
  maxAuthenticatedConnections: 64,
  maxUnauthenticatedConnections: 8,
  maxHttpRequests: 8,
  maxHttpConnections: 32,
  maxQueuedMessages: 32,
  maxQueuedBytes: 1024 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxSessions: 128,
  idleTimeoutMs: 30_000,
  authenticationTimeoutMs: 5_000,
  httpBodyTimeoutMs: 10_000,
  negotiationTtlMs: 30_000,
  audioEndpointSilenceMs: 800,
  audioSpeechRmsThreshold: 25,
  maxProviderOperations: 8,
  providerTimeoutMs: 30_000,
});

export type HubResourceLimits = { -readonly [K in keyof typeof DEFAULT_HUB_LIMITS]: number };

export function loadHubResourceLimits(root: string): HubResourceLimits {
  const filename = process.env.HUB_RESOURCE_LIMITS_PATH?.trim();
  if (!filename) return { ...DEFAULT_HUB_LIMITS };
  const raw: unknown = JSON.parse(fs.readFileSync(path.resolve(root, filename), "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || (raw as { schemaVersion?: unknown }).schemaVersion !== 1
    || Object.keys(raw).sort().join(",") !== "limits,schemaVersion") throw new Error("Invalid Hub resource limits file");
  return resolveHubResourceLimits((raw as { limits: Partial<HubResourceLimits> }).limits);
}

export function resolveHubResourceLimits(overrides: Partial<HubResourceLimits> = {}): HubResourceLimits {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Invalid Hub resource limits");
  const limits: HubResourceLimits = { ...DEFAULT_HUB_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
      throw new Error("Hub resource limits must be known positive bounded integers");
    }
    limits[key as keyof HubResourceLimits] = value;
  }
  if (limits.maxVisionFileBytes > limits.maxVisionBodyBytes) throw new Error("Vision file limit exceeds body limit");
  return limits;
}

export class HubRequestError extends Error {
  constructor(readonly status: 400 | 408 | 413 | 429, message: string) { super(message); }
}

export function rejectHttp(request: http.IncomingMessage, response: http.ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = error instanceof HubRequestError ? error.status
    : error instanceof URIError || error instanceof SyntaxError || error instanceof TypeError ? 400 : 500;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Connection", "close");
  response.end(JSON.stringify({ error: error instanceof HubRequestError ? error.message : "Invalid Hub request" }), () => request.destroy());
}

/** One bounded allocation; reject declared sizes before allocating or reading. */
export function readHubBody(request: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    return Promise.reject(new HubRequestError(400, "Invalid Content-Length"));
  }
  if (declared !== undefined && Number(declared) > maxBytes) {
    return Promise.reject(new HubRequestError(413, "Hub body exceeds byte limit"));
  }
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(declared === undefined ? maxBytes : Number(declared));
    let received = 0;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted);
      if (error) { request.pause(); reject(error); } else resolve(buffer.subarray(0, received));
    };
    const data = (chunk: Buffer): void => {
      if (received + chunk.length > buffer.length) return finish(new HubRequestError(413, "Hub body exceeds byte limit"));
      chunk.copy(buffer, received); received += chunk.length;
    };
    const end = (): void => finish();
    const failed = (): void => finish(new HubRequestError(400, "Hub body interrupted"));
    const aborted = (): void => failed();
    const timer = setTimeout(() => finish(new HubRequestError(408, "Hub body timeout")), timeoutMs);
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
}

export interface HubSocketAdmission {
  authenticate(): boolean;
  release(): void;
}

export class HubResources {
  private authenticated = 0;
  private unauthenticated = 0;
  private requests = 0;
  private closed = false;
  private readonly providers = new Map<AbortController, Promise<unknown>>();
  readonly limits: HubResourceLimits;
  constructor(limits?: Partial<HubResourceLimits>) { this.limits = resolveHubResourceLimits(limits); }

  async runProvider<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    if (this.closed || this.providers.size >= this.limits.maxProviderOperations) throw new HubRequestError(429, "Hub provider quota exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Hub provider deadline exceeded")), this.limits.providerTimeoutMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const pending = Promise.resolve().then(() => { throwIfAborted(signal); return operation(signal); });
    this.providers.set(controller, pending);
    const release = (): void => { clearTimeout(timer); this.providers.delete(controller); };
    void pending.then(release, release);
    return await awaitWithAbort(pending, signal);
  }

  /** Consume the raw provider iterator inside its retained promise. Racing an
   * abortable iterator instead would release admission while next()/return()
   * was still running. Values arriving after detachment never reach callers. */
  runProviderStream<T>(
    operation: (signal: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>,
    consume: (value: T, signal: AbortSignal) => void | Promise<void>,
    parent?: AbortSignal,
  ): Promise<void> {
    return this.runProvider(async signal => {
      const source = await operation(signal);
      for await (const value of source) {
        throwIfAborted(signal);
        await consume(value, signal);
        throwIfAborted(signal);
      }
      throwIfAborted(signal);
    }, parent);
  }

  providerAvailable(): boolean { return !this.closed && this.providers.size < this.limits.maxProviderOperations; }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.providers.keys()) controller.abort(new Error("Hub shutting down"));
    await awaitWithAbort(Promise.allSettled(this.providers.values()), AbortSignal.timeout(this.limits.authenticationTimeoutMs));
  }

  async shutdown(steps: ReadonlyArray<() => unknown>): Promise<void> {
    // Abort providers before waiting for consumers such as world wake queues.
    // Otherwise those consumers can prevent shutdown cancellation from starting.
    const providers = this.close();
    const results = await Promise.allSettled([() => providers, ...steps].map(step =>
      awaitWithAbort(Promise.resolve().then(step), AbortSignal.timeout(this.limits.authenticationTimeoutMs))));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Hub shutdown failed");
  }

  admitSocket(authenticated: boolean): HubSocketAdmission | null {
    if (this.closed) return null;
    if (authenticated ? this.authenticated >= this.limits.maxAuthenticatedConnections
      : this.unauthenticated >= this.limits.maxUnauthenticatedConnections) return null;
    if (authenticated) this.authenticated += 1; else this.unauthenticated += 1;
    let released = false;
    return {
      authenticate: () => {
        if (released) return false;
        if (authenticated) return true;
        if (this.authenticated >= this.limits.maxAuthenticatedConnections) return false;
        this.unauthenticated -= 1; this.authenticated += 1; authenticated = true;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        if (authenticated) this.authenticated -= 1; else this.unauthenticated -= 1;
      },
    };
  }

  admitHttp(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    if (this.closed || this.requests >= this.limits.maxHttpRequests) {
      rejectHttp(request, response, new HubRequestError(429, "Hub request quota exceeded"));
      return false;
    }
    this.requests += 1;
    let released = false;
    const release = (): void => { if (!released) { released = true; this.requests -= 1; } };
    response.once("finish", release); response.once("close", release); request.once("error", release);
    return true;
  }
}

/** Bounded queued work and outbound buffering, including the currently running frame. */
export class HubSocketFlow {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private bytes = 0;
  private stopped = false;
  private rejected = false;
  private idle: NodeJS.Timeout;
  private authenticationTimer: NodeJS.Timeout | undefined;
  constructor(private readonly socket: WebSocket, private readonly limits: HubResourceLimits,
    authenticated: boolean, private readonly cleanup: (rejected: boolean) => void = () => undefined) {
    this.idle = setTimeout(() => this.fail(1008, "Hub idle timeout"), limits.idleTimeoutMs);
    if (!authenticated) this.authenticationTimer = setTimeout(() => this.fail(1008, "Hub authentication timeout"), limits.authenticationTimeoutMs);
    socket.once("error", () => this.stop()); socket.once("close", () => this.stop());
  }
  authenticate(): void { clearTimeout(this.authenticationTimer); }
  touch(): void { if (!this.stopped) this.idle.refresh(); }
  enqueue(raw: RawData, handler: () => Promise<void>): void {
    if (this.stopped) return;
    const bytes = rawBytes(raw);
    if (this.queued + 1 > this.limits.maxQueuedMessages || this.bytes + bytes > this.limits.maxQueuedBytes) {
      this.fail(1008, "Hub message queue exceeded"); return;
    }
    this.idle.refresh(); this.queued += 1; this.bytes += bytes;
    this.chain = this.chain.then(async () => { if (!this.stopped) await handler(); })
      .catch(() => this.fail(1008, "Invalid Hub frame"))
      .finally(() => { this.queued -= 1; this.bytes -= bytes; });
  }
  async send(data: string): Promise<void> {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount + Buffer.byteLength(data) > this.limits.maxBufferedBytes) {
      this.fail(1008, "Hub output buffer exceeded"); throw new Error("Hub output buffer exceeded");
    }
    await new Promise<void>((resolve, reject) => this.socket.send(data, error => error ? reject(error) : resolve()));
  }
  fail(code: number, reason: string): void {
    if (this.stopped) return;
    this.rejected = true;
    this.stop();
    this.socket.close(code, reason);
    // A peer refusing the close handshake must not retain a quota or buffers.
    const timer = setTimeout(() => this.socket.terminate(), this.limits.authenticationTimeoutMs);
    timer.unref(); this.socket.once("close", () => clearTimeout(timer));
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.idle); clearTimeout(this.authenticationTimer); this.cleanup(this.rejected);
  }
}

export function rawBytes(raw: RawData): number {
  return Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength;
}

export class HubAudioBuffer {
  private buffer: Buffer | null = null;
  private bytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private explicit = false;
  private silenceBytes = 0;
  constructor(private readonly limits: HubResourceLimits, private readonly fail: () => void) {}
  start(explicit = true): void {
    if (this.buffer) throw new Error("Overlapping audio utterance");
    this.bytes = 0;
    this.explicit = explicit;
    this.silenceBytes = 0;
    this.buffer = Buffer.allocUnsafe(Math.min(this.limits.maxAudioBytes, Math.floor(this.limits.maxAudioDurationMs * 32)));
    this.timer = setTimeout(() => { this.clear(); this.fail(); }, this.limits.maxAudioDurationMs);
  }
  append(chunk: Buffer): boolean {
    if (chunk.length % 2 !== 0) throw new Error("Audio must be PCM16");
    if (chunk.length === 0) return false;
    if (this.bytes === 0 && /^(?:RIFF|OggS|fLaC|ID3)/u.test(chunk.subarray(0, 4).toString("ascii"))) {
      throw new Error("Encoded audio is not raw PCM16");
    }
    // Check admission before scanning samples. All implicit input is fixed
    // little-endian 16kHz mono PCM16, as advertised by session.ready.
    const capacity = Math.min(this.limits.maxAudioBytes, Math.floor(this.limits.maxAudioDurationMs * 32));
    if (this.bytes + chunk.length > capacity) {
      this.clear(); throw new Error("Audio utterance exceeds limit");
    }
    let energy = 0;
    for (let offset = 0; offset < chunk.length; offset += 2) energy += chunk.readInt16LE(offset) ** 2;
    const speech = Math.sqrt(energy / (chunk.length / 2)) >= this.limits.audioSpeechRmsThreshold;
    // Continuous room silence isn't an utterance and mustn't invoke STT.
    if (!this.buffer && !speech) return false;
    if (!this.buffer) this.start(false);
    chunk.copy(this.buffer!, this.bytes); this.bytes += chunk.length;
    this.silenceBytes = speech ? 0 : this.silenceBytes + chunk.length;
    return !this.explicit && this.silenceBytes >= this.limits.audioEndpointSilenceMs * 32;
  }
  finish(): Buffer {
    const pcm = this.buffer?.subarray(0, this.bytes) ?? Buffer.alloc(0);
    this.clear(); return pcm;
  }
  clear(): void { clearTimeout(this.timer); this.buffer = null; this.bytes = 0; }
}
