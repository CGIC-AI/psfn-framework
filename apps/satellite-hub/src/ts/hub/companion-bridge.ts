import type { CompanionBridgeConfig } from "../shared/env.js";
import type {
  ApprovalRequestedMessage,
  ApprovalResolvedMessage,
  ApprovalResolutionStatus,
  ArtifactCreatedMessage,
  EmotionSnapshotMessage,
  ToolActivityMessage,
  ToolActivityPhase,
  TouchRegion,
  TouchStimulusKind,
} from "../shared/protocol.js";

export type CompanionEvent =
  | { kind: "approval.requested"; payload: ApprovalRequestedMessage["data"] }
  | { kind: "approval.resolved"; payload: ApprovalResolvedMessage["data"] }
  | { kind: "artifact.created"; payload: ArtifactCreatedMessage["data"] }
  | { kind: "tool.activity"; payload: ToolActivityMessage["data"] }
  | { kind: "emotion.snapshot"; payload: EmotionSnapshotMessage["data"] };

export type CompanionEventListener = (event: CompanionEvent) => void;

const APPROVAL_RESOLUTION_STATUSES: readonly ApprovalResolutionStatus[] = [
  "approved",
  "denied",
  "expired",
  "blocked",
];

const TOOL_ACTIVITY_PHASES: readonly ToolActivityPhase[] = [
  "started",
  "progress",
  "completed",
  "failed",
];

export class CompanionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CompanionRequestError";
  }
}

/**
 * Bridges the PSFN companion backplane HTTP surface into the hub.
 *
 * - Consumes the authenticated `GET <base>/companion/events` SSE stream with
 *   reconnect/backoff and fans validated, contract-projected events out to
 *   registered listeners.
 * - Proxies approval decisions to `POST <base>/companion/approvals/{id}`.
 * - Proxies size-capped artifact previews from
 *   `GET <base>/companion/artifacts/{id}/preview`.
 *
 * The bridge never fabricates data: events that fail strict validation are
 * logged and dropped. Unknown payload fields are stripped from established
 * projected messages or rejected when the redacted contract must pass as-is,
 * so nothing beyond the wire contract can leak to satellites.
 */
export class CompanionBridge {
  private readonly listeners = new Set<CompanionEventListener>();
  private abortController: AbortController | null = null;
  private runTask: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly config: CompanionBridgeConfig) {
    const { satelliteId, endpointId, claimType } = config.identity;
    if (!satelliteId.trim() || !endpointId.trim() || !claimType.trim()) {
      throw new Error(
        "Companion bridge requires a complete satellite registry identity (satelliteId, endpointId, claimType)",
      );
    }
  }

  start(): void {
    if (this.runTask) {
      throw new Error("Companion bridge is already started");
    }
    this.stopped = false;
    this.abortController = new AbortController();
    this.runTask = this.runEventLoop().catch((error) => {
      console.error("Companion bridge event loop terminated:", error);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    if (this.runTask) {
      await this.runTask;
      this.runTask = null;
    }
    this.abortController = null;
  }

  addListener(listener: CompanionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submitApprovalDecision(input: {
    approvalId: string;
    decision: "approve" | "deny";
    satelliteId: string;
    deviceId: string;
  }): Promise<{ id: string; status: string }> {
    const approvalId = input.approvalId.trim();
    if (!approvalId) {
      throw new Error("Approval decision requires a non-empty approval id");
    }
    const response = await fetch(
      `${this.config.baseUrl}/companion/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          decision: input.decision,
          satelliteId: input.satelliteId,
          deviceId: input.deviceId,
        }),
      },
    );
    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new CompanionRequestError(
        response.status,
        `Companion approval decision failed (${response.status})${body ? `: ${body}` : ""}`,
      );
    }
    const payload = await response.json() as { id?: unknown; status?: unknown };
    const id = readRequiredString(payload.id, "approval decision response id");
    const status = readRequiredString(payload.status, "approval decision response status");
    return { id, status };
  }

  async submitTouchStimulus(input: {
    sessionId: string;
    deviceId: string;
    kind: TouchStimulusKind;
    region: TouchRegion;
    count: number;
    durationMs: number;
    responseMode: "respond" | "observe";
  }): Promise<{ status: "accepted"; messageId: string; response?: string }> {
    const response = await fetch(`${this.config.baseUrl}/companion/stimuli`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...this.config.identity,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        kind: input.kind,
        region: input.region,
        count: input.count,
        durationMs: input.durationMs,
        responseMode: input.responseMode,
      }),
    });
    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new CompanionRequestError(
        response.status,
        `Companion touch stimulus failed (${response.status})${body ? `: ${body}` : ""}`,
      );
    }
    const payload = await response.json() as {
      status?: unknown;
      messageId?: unknown;
      response?: unknown;
    };
    if (payload.status !== "accepted") {
      throw new Error("Companion touch stimulus response status must be 'accepted'");
    }
    const messageId = readRequiredString(payload.messageId, "touch stimulus response messageId");
    const responseText = payload.response === undefined
      ? undefined
      : readRequiredString(payload.response, "touch stimulus response text");
    return {
      status: "accepted",
      messageId,
      ...(responseText ? { response: responseText } : {}),
    };
  }

  async fetchArtifactPreview(artifactId: string): Promise<{ mediaType: string; dataBase64: string }> {
    const normalizedId = artifactId.trim();
    if (!normalizedId) {
      throw new Error("Artifact preview requires a non-empty artifact id");
    }
    const controller = new AbortController();
    const response = await fetch(
      `${this.config.baseUrl}/companion/artifacts/${encodeURIComponent(normalizedId)}/preview?${this.identityQuery()}`,
      {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new CompanionRequestError(
        response.status,
        `Companion artifact preview failed (${response.status})${body ? `: ${body}` : ""}`,
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!mediaType) {
      controller.abort();
      throw new Error("Companion artifact preview response did not include a content type");
    }
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isInteger(declaredLength) && declaredLength > this.config.previewMaxBytes) {
      controller.abort();
      throw new Error(
        `Companion artifact preview exceeds the size cap (${declaredLength} > ${this.config.previewMaxBytes} bytes)`,
      );
    }
    if (!response.body) {
      throw new Error("Companion artifact preview response did not include a body");
    }
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > this.config.previewMaxBytes) {
        controller.abort();
        throw new Error(
          `Companion artifact preview exceeds the size cap (> ${this.config.previewMaxBytes} bytes)`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return {
      mediaType,
      dataBase64: Buffer.concat(chunks).toString("base64"),
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private identityQuery(): string {
    return new URLSearchParams({
      satelliteId: this.config.identity.satelliteId,
      endpointId: this.config.identity.endpointId,
      claimType: this.config.identity.claimType,
    }).toString();
  }

  private async runEventLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const connected = await this.consumeEventStream();
        if (connected) {
          attempt = 0;
        }
      } catch (error) {
        if (this.stopped) {
          return;
        }
        console.error("Companion event stream failed:", error);
      }
      if (this.stopped) {
        return;
      }
      attempt += 1;
      await this.sleep(reconnectDelayMs(this.config, attempt));
    }
  }

  private async consumeEventStream(): Promise<boolean> {
    const signal = this.abortController?.signal;
    const response = await fetch(`${this.config.baseUrl}/companion/events?${this.identityQuery()}`, {
      method: "GET",
      headers: {
        ...this.buildHeaders(),
        Accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new CompanionRequestError(
        response.status,
        `Companion event stream request failed (${response.status})${body ? `: ${body}` : ""}`,
      );
    }
    if (!response.body) {
      throw new Error("Companion event stream response did not include a body");
    }
    const parser = new SseStreamParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      for (const rawEvent of parser.push(decoder.decode(value, { stream: true }))) {
        this.dispatchRawEvent(rawEvent);
      }
    }
    return true;
  }

  private dispatchRawEvent(rawEvent: SseEvent): void {
    if (rawEvent.event !== "companion") {
      return;
    }
    let event: CompanionEvent;
    try {
      event = parseCompanionEventData(rawEvent.data);
    } catch (error) {
      console.error("Dropping invalid companion event:", error);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Companion event listener failed:", error);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function reconnectDelayMs(
  config: Pick<CompanionBridgeConfig, "reconnectBaseMs" | "reconnectMaxMs">,
  attempt: number,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16);
  return Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** exponent);
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Minimal incremental server-sent-events parser. Only `event:` and `data:`
 * fields are used; comments and other fields are ignored per the SSE spec.
 */
export class SseStreamParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    while (true) {
      const boundary = findEventBoundary(this.buffer);
      if (!boundary) {
        break;
      }
      const rawBlock = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const event = parseEventBlock(rawBlock);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0] ?? null;
}

function parseEventBlock(block: string): SseEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event: eventName, data: dataLines.join("\n") };
}

/**
 * Strictly validates a companion SSE payload and projects it onto the exact
 * wire-contract shape. Unknown fields are dropped so the hub can never relay
 * anything beyond the redacted contract fields.
 */
export function parseCompanionEventData(data: string): CompanionEvent {
  const envelope = JSON.parse(data) as unknown;
  if (!isRecord(envelope)) {
    throw new Error("Companion event envelope must be a JSON object");
  }
  const kind = envelope.kind;
  const payload = envelope.payload;
  if (!isRecord(payload)) {
    throw new Error("Companion event payload must be a JSON object");
  }
  readRequiredString(envelope.emittedAt, "companion event emittedAt");
  switch (kind) {
    case "approval.requested":
      return { kind, payload: projectApprovalRequested(payload) };
    case "approval.resolved":
      return { kind, payload: projectApprovalResolved(payload) };
    case "artifact.created":
      return { kind, payload: projectArtifactCreated(payload) };
    case "tool.activity":
      return { kind, payload: projectToolActivity(payload) };
    case "emotion.snapshot":
      return { kind, payload: projectEmotionSnapshot(payload) };
    default:
      throw new Error(`Unsupported companion event kind: ${String(kind)}`);
  }
}

function projectApprovalRequested(payload: Record<string, unknown>): ApprovalRequestedMessage["data"] {
  if (payload.status !== "pending") {
    throw new Error("approval.requested payload status must be 'pending'");
  }
  const expiresAt = readOptionalString(payload.expiresAt, "approval.requested expiresAt");
  return {
    id: readRequiredString(payload.id, "approval.requested id"),
    title: readRequiredString(payload.title, "approval.requested title"),
    requestedAt: readRequiredString(payload.requestedAt, "approval.requested requestedAt"),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    redactedContext: readStringField(payload.redactedContext, "approval.requested redactedContext"),
    status: "pending",
  };
}

function projectApprovalResolved(payload: Record<string, unknown>): ApprovalResolvedMessage["data"] {
  const status = payload.status;
  if (!APPROVAL_RESOLUTION_STATUSES.includes(status as ApprovalResolutionStatus)) {
    throw new Error(`approval.resolved payload status is invalid: ${String(status)}`);
  }
  return {
    id: readRequiredString(payload.id, "approval.resolved id"),
    status: status as ApprovalResolutionStatus,
    resolvedAt: readRequiredString(payload.resolvedAt, "approval.resolved resolvedAt"),
  };
}

function projectArtifactCreated(payload: Record<string, unknown>): ArtifactCreatedMessage["data"] {
  if (typeof payload.previewable !== "boolean") {
    throw new Error("artifact.created payload previewable must be a boolean");
  }
  return {
    id: readRequiredString(payload.id, "artifact.created id"),
    label: readRequiredString(payload.label, "artifact.created label"),
    mediaType: readRequiredString(payload.mediaType, "artifact.created mediaType"),
    provenance: readRequiredString(payload.provenance, "artifact.created provenance"),
    createdAt: readRequiredString(payload.createdAt, "artifact.created createdAt"),
    previewable: payload.previewable,
  };
}

function projectToolActivity(payload: Record<string, unknown>): ToolActivityMessage["data"] {
  const phase = payload.phase;
  if (!TOOL_ACTIVITY_PHASES.includes(phase as ToolActivityPhase)) {
    throw new Error(`tool.activity payload phase is invalid: ${String(phase)}`);
  }
  const detail = readOptionalString(payload.detail, "tool.activity detail");
  return {
    id: readRequiredString(payload.id, "tool.activity id"),
    tool: readRequiredString(payload.tool, "tool.activity tool"),
    phase: phase as ToolActivityPhase,
    ...(detail !== undefined ? { detail } : {}),
    timestamp: readRequiredString(payload.timestamp, "tool.activity timestamp"),
  };
}

function projectEmotionSnapshot(payload: Record<string, unknown>): EmotionSnapshotMessage["data"] {
  requireExactKeys(
    payload,
    ["trigger", "vad", "mood", "discrete", "confidence", "timestamp"],
    ["acacAxes"],
    "emotion.snapshot payload",
  );
  if (payload.trigger !== "post_turn" && payload.trigger !== "vad_shift") {
    throw new Error(`emotion.snapshot payload trigger is invalid: ${String(payload.trigger)}`);
  }
  validateEmotionVector(payload.vad, "emotion.snapshot vad");
  validateEmotionVector(payload.mood, "emotion.snapshot mood");
  validateEmotionDiscrete(payload.discrete);
  validateUnitInterval(payload.confidence, "emotion.snapshot confidence");
  validateEmotionAcacAxes(payload.acacAxes);
  validateIsoTimestamp(payload.timestamp, "emotion.snapshot timestamp");

  // Preserve the PSFN-owned redacted payload object and field ordering exactly.
  return payload as unknown as EmotionSnapshotMessage["data"];
}

function validateEmotionVector(value: unknown, name: string): void {
  if (!isRecord(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  requireExactKeys(value, ["valence", "arousal", "dominance"], [], name);
  validateSignedUnit(value.valence, `${name}.valence`);
  validateSignedUnit(value.arousal, `${name}.arousal`);
  validateSignedUnit(value.dominance, `${name}.dominance`);
}

function validateEmotionDiscrete(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("emotion.snapshot discrete must contain at most 32 entries");
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`emotion.snapshot discrete[${index}] must be a JSON object`);
    }
    requireExactKeys(entry, ["label", "score"], [], `emotion.snapshot discrete[${index}]`);
    if (typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > 64) {
      throw new Error(`emotion.snapshot discrete[${index}].label is invalid`);
    }
    validateUnitInterval(entry.score, `emotion.snapshot discrete[${index}].score`);
  });
}

function validateEmotionAcacAxes(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error("emotion.snapshot acacAxes must contain at most four entries");
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`emotion.snapshot acacAxes[${index}] must be a JSON object`);
    }
    requireExactKeys(entry, ["axis", "score"], [], `emotion.snapshot acacAxes[${index}]`);
    const axis = entry.axis;
    if (axis !== "agency" && axis !== "connection" && axis !== "authenticity" && axis !== "curiosity") {
      throw new Error(`emotion.snapshot acacAxes[${index}].axis is invalid`);
    }
    if (seen.has(axis)) {
      throw new Error(`emotion.snapshot acacAxes axis is duplicated: ${axis}`);
    }
    seen.add(axis);
    validateUnitInterval(entry.score, `emotion.snapshot acacAxes[${index}].score`);
  });
}

function validateSignedUnit(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${name} must be a finite number from -1 through 1`);
  }
}

function validateUnitInterval(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number from 0 through 1`);
  }
}

function validateIsoTimestamp(value: unknown, name: string): void {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${name} contains an unsupported field`);
  }
  if (required.some((key) => !(key in value))) {
    throw new Error(`${name} is missing a required field`);
  }
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Companion event field is missing or empty: ${name}`);
  }
  return value;
}

function readStringField(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Companion event field must be a string: ${name}`);
  }
  return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readStringField(value, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
