import { createHash } from "node:crypto";

const EVENTS = new Set<string>(["ALSA volume control failed:","Active Hub device enrollment fenced:","Amica bridge interrupt post failed:","Audio capture failed:","Companion bridge event loop terminated:","Companion event listener failed:","Companion event stream failed:","Connected to hub:","Dropping invalid companion event:","Eidoverse MCP connected","Eidoverse MCP disconnected","Eidoverse MCP look failed","Eidoverse MCP reconnect budget exhausted","Eidoverse MCP reconnected","Eidoverse MCPL connected","Eidoverse MCPL delivered a malformed incoming batch","Eidoverse MCPL disconnected","Eidoverse MCPL door sent a malformed channels/changed notification","Eidoverse MCPL frame could not be sent","Eidoverse MCPL frame was malformed and was dropped","Eidoverse MCPL incoming batch failed","Eidoverse MCPL incoming delivery failed","Eidoverse MCPL look failed","Eidoverse MCPL reconnect budget exhausted","Eidoverse MCPL reconnected","Eidoverse MCPL travel is not available under this hub's feature sets","Eidoverse MCPL wake turn failed","Eidoverse MCPL world resync failed","Eidoverse ambient delivery failed","Eidoverse body action failed","Eidoverse body action was refused","Eidoverse in-world say failed","Eidoverse pending_pings poll failed","Eidoverse snapshot could not be persisted","Eidoverse snapshot exceeds the configured size budget","Eidoverse snapshot failed","Eidoverse snapshot is unavailable","Eidoverse snapshot returned an unsupported content type","Eidoverse travel request failed","Eidoverse wake turn failed","Eidoverse world belief resynced from the door","Eidoverse world resync refused: invalid world name","ElevenLabs TTS stream failed:","Failed to close cancelled ElevenLabs TTS context:","Hub connection closed","Hub device registry reload failed:","Hub error:","Hub websocket error:","Location transition delivery failed","Pi client failing closed:","Pi client message handling failed:","Realtime client connected","Realtime connection failed:","Realtime reply task failed:","Relay client connected to hub:","Relay hub connection closed","Relay hub error:","Relay websocket error:","Satellite Hub developer mode: local unauthenticated callers can invoke providers; use only on a trusted loopback host","TS Pi client failed to start:","Touch interaction delivery failed","Unable to load PSFN runtime identity:","Voxta TTS artifact generation failed:","Voxta audio input finalization failed:","Voxta message handling failed:","Voxta reply observer failed:","audio-end","audio-init","call_initialized","interrupt-event","owner-mode segment ended without buffered audio","playback.closed graceful=false","playback.closed graceful=true","Companion audio output publish failed","hub.realtime.hello","hub.realtime.transcript","hub.realtime.reply","hub.listen","hub.control.listen","psfn.reply"]);
const NUMBERS = new Set(["bytes", "chars", "latencyMs", "durationMs", "totalMs", "deadlineMs", "attempt", "port", "chunks", "generation", "queued", "dropped"]);
const IDS = new Set(["requestId", "sessionId", "conversationId", "deviceId", "turnId", "correlationId"]);
const OUTCOMES = new Set(["success", "failed", "cancelled", "primary", "recovered", "accepted", "rejected", "connected", "closed", "timeout"]);
for (const event of ["Hub artifact expiry failed", "Hub shutdown failed", "Eidoverse wake skipped: addressed another participant", "Eidoverse wake accepted", "Eidoverse world emanation enrolled", "Eidoverse world emanation has no active Hub device enrollment; wake turns carry no device assertion", "Eidoverse body walk_to no_position", "Eidoverse body walk_to walking", "Eidoverse body walk_to completed", "Eidoverse body action completed", "Eidoverse move refused", "Eidoverse travel refused", "Eidoverse MCPL wake dispatch queue full", "Eidoverse MCPL wake dispatch queue drained", "Eidoverse MCPL feature sets degraded", "Eidoverse MCPL door refused the feature-set policy; every selected set is degraded", "Eidoverse MCPL feature-set receipt was unreadable; every selected set is degraded"]) EVENTS.add(event);
for (const outcome of ["arrived", "interrupted", "interrupted-or-timed-out", "no_position", "walking", "refused", "unmapped_world", "not_configured", "position_unknown", "unavailable", "not_allowlisted"]) OUTCOMES.add(outcome);
for (const field of ["limit", "episodeDroppedBatches", "episodeDroppedMessages", "droppedBatches", "droppedMessages", "degradedSets"]) NUMBERS.add(field);
type Level = "log" | "info" | "warn" | "error" | "debug" | "trace";

function privateFields(input: unknown): Record<string, unknown> {
  if (input instanceof Error) return { errorName: ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "SyntaxError"].includes(input.name) ? input.name : "Error" };
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (IDS.has(key) && typeof value === "string") output[key + "Tag"] = createHash("sha256").update(value).digest("hex").slice(0, 16);
    else if ((key === "outcome" || key === "status") && typeof value === "string" && OUTCOMES.has(value)) output[key] = value;
    else if (key === "error") Object.assign(output, privateFields(value));
    else if (key === "graceful" && typeof value === "boolean") output[key] = value;
  }
  return output;
}

/** Only registered static event names and content-free operational fields cross a sink. */
export function privateLogRecord(level: Level, first: unknown, ...fields: unknown[]): string {
  const event = typeof first === "string" && EVENTS.has(first) ? first : "hub.diagnostic";
  return JSON.stringify({ level: level === "log" ? "info" : level, event, ...privateFields(first), ...Object.assign({}, ...fields.map(privateFields)) });
}

function emit(level: Level, args: unknown[]): void {
  const output = privateLogRecord(level, args[0], ...args.slice(1));
  globalThis.console[level === "trace" ? "debug" : level](output);
}

export const hubConsole = {
  log: (...args: unknown[]) => emit("log", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
  debug: (...args: unknown[]) => emit("debug", args),
  trace: (...args: unknown[]) => emit("trace", args),
};

/** A custom observer is still a log transport, not permission to reveal content. */
export function privateHubLogger(sink: { info?: (message: string) => void; warn: (message: string) => void }) {
  if (sink === hubConsole || PRIVATE_SINKS.has(sink)) return sink as { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  const wrapped = {
    info: (...args: unknown[]) => sink.info?.(privateLogRecord("info", args[0], ...args.slice(1))),
    warn: (...args: unknown[]) => sink.warn(privateLogRecord("warn", args[0], ...args.slice(1))),
  };
  PRIVATE_SINKS.add(wrapped);
  return wrapped;
}
const PRIVATE_SINKS = new WeakSet<object>();
