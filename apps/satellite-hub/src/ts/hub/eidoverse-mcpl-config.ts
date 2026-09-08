/**
 * Bootstrap configuration for the Hub's MCPL door transport.
 *
 * The Phase 1 `pending_pings` poll stays the default. A deployment selects the
 * MCPL door explicitly with `EIDOVERSE_MCP_TRANSPORT=mcpl`, so an environment
 * whose world fronts only the plain-MCP stdio door keeps working unchanged.
 *
 * Everything tunable — timeouts, backoff, the grant, the catch-up wake decision
 * — is read from configuration here and never inlined at a call site. The
 * defaults below are bootstrap fallbacks in the same shape the Phase 1 loader
 * already uses; the chart renders each of them explicitly.
 */

import {
  optionalEnv,
  positiveIntegerEnv,
  requiredEnv,
} from "./eidoverse-mcp.js";
import {
  EIDOVERSE_FEATURE_SET_USES,
  effectiveCapabilitiesForFeatureSets,
  type McplCapabilityPath,
} from "./eidoverse-mcpl-wire.js";

const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_AMBIENT_SAY_DEBOUNCE_MS = 180_000;

/**
 * Feature sets the Hub grants unless the operator narrows them. Presence,
 * the body's tools, and travel. `eidoverse.typing` is deliberately absent: it
 * is cosmetic, it draws on `channels.streaming` alone, and leaving it ungranted
 * proves that refusing it cannot take the world down with it.
 */
const DEFAULT_FEATURE_SETS: readonly string[] = [
  "eidoverse.world",
  "eidoverse.embodiment",
  "eidoverse.travel",
];

export type EidoverseMcpTransport = "poll" | "mcpl";

export interface EidoverseMcplConfig {
  doorUrl: string;
  tokenRef: string;
  worldName: string;
  agentName: string;
  /** Feature sets this host grants; the capability allowlist is derived. */
  featureSets: readonly string[];
  effectiveCapabilities: readonly McplCapabilityPath[];
  /**
   * Whether a replayed mention delivered after a reconnect keeps its original
   * addressing and can start a turn. Default false — see the wake-filter table.
   */
  catchupWake: boolean;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectMaxAttempts: number;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  ambientSayDebounceMs: number;
}

/**
 * Which Eidoverse transport this deployment selected. Unknown values fail
 * closed rather than silently falling back to a door the operator did not name.
 */
export function loadEidoverseMcpTransport(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EidoverseMcpTransport {
  const raw = optionalEnv(env, "EIDOVERSE_MCP_TRANSPORT");
  if (raw === undefined) return "poll";
  if (raw !== "poll" && raw !== "mcpl") {
    throw new Error("EIDOVERSE_MCP_TRANSPORT must be 'poll' or 'mcpl'");
  }
  return raw;
}

/**
 * Load the MCPL door configuration, or null when the Eidoverse client is
 * disabled or this deployment selected the Phase 1 poll transport.
 */
export function loadEidoverseMcplConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EidoverseMcplConfig | null {
  const enabled = optionalEnv(env, "EIDOVERSE_MCP_ENABLED");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new Error("EIDOVERSE_MCP_ENABLED must be 'true' or 'false'");
  }
  if (enabled !== "true") return null;
  if (loadEidoverseMcpTransport(env) !== "mcpl") return null;

  const doorUrl = parseDoorUrl(requiredEnv(env, "EIDOVERSE_MCPL_DOOR_URL"));
  const tokenRef = requiredEnv(env, "EIDOVERSE_MCP_TOKEN_REF");
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenRef)) {
    throw new Error("EIDOVERSE_MCP_TOKEN_REF must name an environment credential");
  }
  const worldName = requiredEnv(env, "EIDOVERSE_MCP_WORLD_NAME");
  const agentName = requiredEnv(env, "EIDOVERSE_MCP_AGENT_NAME");
  const featureSets = parseFeatureSets(optionalEnv(env, "EIDOVERSE_MCPL_FEATURE_SETS_JSON"));
  const catchupWake = parseBoolean(env, "EIDOVERSE_MCPL_CATCHUP_WAKE", false);
  const reconnectBaseMs = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_RECONNECT_BASE_MS",
    DEFAULT_RECONNECT_BASE_MS,
  );
  const reconnectMaxMs = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_RECONNECT_MAX_MS",
    DEFAULT_RECONNECT_MAX_MS,
  );
  if (reconnectMaxMs < reconnectBaseMs) {
    throw new Error("EIDOVERSE_MCP_RECONNECT_MAX_MS must be >= EIDOVERSE_MCP_RECONNECT_BASE_MS");
  }

  return {
    doorUrl,
    tokenRef,
    worldName,
    agentName,
    featureSets,
    effectiveCapabilities: effectiveCapabilitiesForFeatureSets(featureSets),
    catchupWake,
    reconnectBaseMs,
    reconnectMaxMs,
    reconnectMaxAttempts: positiveIntegerEnv(
      env,
      "EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS",
      DEFAULT_RECONNECT_MAX_ATTEMPTS,
    ),
    requestTimeoutMs: positiveIntegerEnv(
      env,
      "EIDOVERSE_MCP_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    handshakeTimeoutMs: positiveIntegerEnv(
      env,
      "EIDOVERSE_MCPL_HANDSHAKE_TIMEOUT_MS",
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ),
    ambientSayDebounceMs: positiveIntegerEnv(
      env,
      "EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS",
      DEFAULT_AMBIENT_SAY_DEBOUNCE_MS,
    ),
  };
}

/**
 * The door URL carries the MCPL path and must stay credential-free: the
 * identity token is attached at dial time and never travels through config.
 */
function parseDoorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EIDOVERSE_MCPL_DOOR_URL must be a valid ws or wss URL");
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
    throw new Error("EIDOVERSE_MCPL_DOOR_URL must be a credential-free ws or wss URL");
  }
  if (url.search || url.hash) {
    throw new Error("EIDOVERSE_MCPL_DOOR_URL must not carry a query string or fragment");
  }
  return url.toString();
}

function parseFeatureSets(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_FEATURE_SETS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("EIDOVERSE_MCPL_FEATURE_SETS_JSON must be a JSON string array");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("EIDOVERSE_MCPL_FEATURE_SETS_JSON must be a JSON string array");
  }
  const names = [...new Set(parsed as string[])];
  if (names.length === 0) {
    throw new Error("EIDOVERSE_MCPL_FEATURE_SETS_JSON must name at least one feature set");
  }
  for (const name of names) {
    if (!(name in EIDOVERSE_FEATURE_SET_USES)) {
      throw new Error(`EIDOVERSE_MCPL_FEATURE_SETS_JSON names an unknown feature set: ${name}`);
    }
  }
  return names;
}

function parseBoolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be 'true' or 'false'`);
  return raw === "true";
}
