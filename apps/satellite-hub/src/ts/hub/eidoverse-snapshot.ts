import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { EidoverseMcpConfig } from "./eidoverse-mcp.js";
import {
  defaultCapabilitiesForProfile,
  frameworkCapabilitiesForSatelliteCapabilities,
  type PsfnSatelliteClaimConfig,
} from "./satellite-claim.js";
import type { VisionCaptureImage } from "./embodied-session.js";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 4_000;
const DEFAULT_SNAPSHOT_MAX_BYTES = 4_000_000;

/** Protocol constants of the door's `/snap` surface, not tuning values. */
const SNAPSHOT_PATH = "/snap";
const SNAPSHOT_MIME_TYPE = "image/png";
const SNAPSHOT_VIEW = "first";
const SNAPSHOT_SOURCE = "eidoverse";
const SNAPSHOT_LABEL = "first-person";

export interface EidoverseSnapshotConfig {
  baseUrl: string;
  worldName: string;
  agentName: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface EidoverseSnapshotLogger {
  warn(message: string): void;
}

export interface EidoverseSnapshotDependencies {
  artifactsRoot: string;
  logger?: EidoverseSnapshotLogger;
  fetchImpl?: typeof fetch;
}

/**
 * First-person vision for the Eidoverse world avatar.
 *
 * The world serves its own views over `GET /snap`, which requires a live
 * spectator renderer attached to that world — a third moving part beyond the
 * world sequencer and the Hub's own door connection. It can legitimately be
 * absent (503), the followed identity may not be present (404), and the
 * renderer may never produce a frame (504). Every one of those degrades to the
 * existing text `look()` notes: `capture` returns null and the turn continues
 * with no image and no crash.
 */
export class EidoverseSnapshotSource {
  private readonly logger: EidoverseSnapshotLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: EidoverseSnapshotConfig,
    private readonly deps: EidoverseSnapshotDependencies,
  ) {
    if (config.timeoutMs <= 0 || config.maxBytes <= 0) {
      throw new Error("Eidoverse snapshot timeout and size budget must be positive");
    }
    this.logger = deps.logger ?? console;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async capture(sessionId: string): Promise<VisionCaptureImage | null> {
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await this.fetchImpl(this.snapshotUrl(), {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      // Timeout, refused connection, or DNS failure: the renderer is simply
      // unavailable for this turn. Never log the URL — it is a sibling of the
      // credentialed world URL.
      this.logger.warn("Eidoverse snapshot is unavailable");
      return null;
    }
    if (!response.ok) {
      await discardBody(response);
      this.logger.warn(`Eidoverse snapshot is unavailable (status ${response.status})`);
      return null;
    }
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (mimeType !== SNAPSHOT_MIME_TYPE) {
      await discardBody(response);
      this.logger.warn("Eidoverse snapshot returned an unsupported content type");
      return null;
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > this.config.maxBytes) {
      await discardBody(response);
      this.logger.warn("Eidoverse snapshot exceeds the configured size budget");
      return null;
    }
    const image = await this.readBounded(response);
    if (!image) {
      this.logger.warn("Eidoverse snapshot exceeds the configured size budget");
      return null;
    }
    try {
      return this.persist(sessionId, requestId, image);
    } catch {
      this.logger.warn("Eidoverse snapshot could not be persisted");
      return null;
    }
  }

  private snapshotUrl(): string {
    const url = new URL(`${this.config.baseUrl}${SNAPSHOT_PATH}`);
    url.searchParams.set("world", this.config.worldName);
    url.searchParams.set("follow", this.config.agentName);
    url.searchParams.set("view", SNAPSHOT_VIEW);
    return url.toString();
  }

  /**
   * Bounds the read itself rather than checking a fully buffered body: an
   * unbounded or mis-declared payload is abandoned as soon as it passes the
   * budget, not after it has been held in memory.
   */
  private async readBounded(response: Response): Promise<Buffer | null> {
    const body = response.body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.config.maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    return Buffer.concat(chunks);
  }

  private persist(sessionId: string, requestId: string, image: Buffer): VisionCaptureImage {
    const capturedAt = new Date();
    const dateKey = capturedAt.toISOString().slice(0, 10).replaceAll("-", "");
    const directory = path.join(this.deps.artifactsRoot, "eidoverse-vision", dateKey);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(
      directory,
      `eidoverse_${safePathPart(sessionId)}_${safePathPart(requestId)}.png`,
    );
    fs.writeFileSync(filePath, image);
    return {
      requestId,
      sessionId,
      source: SNAPSHOT_SOURCE,
      label: SNAPSHOT_LABEL,
      mimeType: SNAPSHOT_MIME_TYPE,
      filePath,
      bytes: image.length,
      capturedAt: capturedAt.toISOString(),
      dataBase64: image.toString("base64"),
    };
  }
}

/**
 * The world's HTTP surface is the same origin as its WebSocket door: swap the
 * scheme, drop the `/ws` suffix, and drop the query string that carries the
 * join credential. Mirrors the door agent's own `httpBase` derivation.
 */
export function deriveEidoverseSnapshotBaseUrl(worldUrl: string): string {
  const url = new URL(worldUrl);
  if (url.username || url.password) {
    throw new Error("Eidoverse snapshot base URL must be credential-free");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

/**
 * Vision is opt-in twice over: `EIDOVERSE_SNAPSHOT_ENABLED` defaults to false,
 * and the claim profile must declare `vision_upload` (the `vision` framework
 * capability) before a snapshot source is built at all.
 */
export function loadEidoverseSnapshotConfig(
  mcp: EidoverseMcpConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EidoverseSnapshotConfig | null {
  const enabled = env.EIDOVERSE_SNAPSHOT_ENABLED?.trim();
  if (enabled !== undefined && enabled !== "" && enabled !== "true" && enabled !== "false") {
    throw new Error("EIDOVERSE_SNAPSHOT_ENABLED must be 'true' or 'false'");
  }
  if (enabled !== "true") return null;
  const override = env.EIDOVERSE_SNAPSHOT_BASE_URL?.trim();
  const baseUrl = override
    ? normalizeSnapshotBaseUrl(override)
    : deriveEidoverseSnapshotBaseUrl(mcp.worldUrl);
  return {
    baseUrl,
    worldName: mcp.worldName,
    agentName: mcp.agentName,
    timeoutMs: positiveIntegerEnv(env, "EIDOVERSE_SNAPSHOT_TIMEOUT_MS", DEFAULT_SNAPSHOT_TIMEOUT_MS),
    maxBytes: positiveIntegerEnv(env, "EIDOVERSE_SNAPSHOT_MAX_BYTES", DEFAULT_SNAPSHOT_MAX_BYTES),
  };
}

export function claimGrantsEidoverseVision(claim: PsfnSatelliteClaimConfig): boolean {
  const capabilities = defaultCapabilitiesForProfile(claim.capabilityProfile);
  return frameworkCapabilitiesForSatelliteCapabilities(capabilities, claim.capabilityProfile)
    .includes("vision");
}

/** An explicit override is already an HTTP origin: keep its scheme intact and
 *  only strip the query, fragment, and trailing slash. */
function normalizeSnapshotBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EIDOVERSE_SNAPSHOT_BASE_URL must be an http or https URL");
  }
  if (url.username || url.password) {
    throw new Error("EIDOVERSE_SNAPSHOT_BASE_URL must be credential-free");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already finished with.
  }
}

function safePathPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
}

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
