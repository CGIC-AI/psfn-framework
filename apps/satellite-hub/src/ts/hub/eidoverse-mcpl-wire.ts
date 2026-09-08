/**
 * Minimal MCPL wire vocabulary for the Hub's Eidoverse door client.
 *
 * Hand-written subset of `@animalabs/mcpl-core` 0.3.0 (`dist/src/{methods,
 * types,capabilities}.d.ts`) plus the Eidoverse producer tag namespace from
 * that project's `mcpl/declaration.ts`. Vendored deliberately rather than
 * depended on: the Hub needs a dozen literals and six record shapes, the
 * package is an optional peer of the door and is not published as a Hub
 * dependency, and a runtime dependency here would put an unpinned third-party
 * protocol library on the Hub's supply chain for no additional behavior.
 *
 * Everything in this file is protocol description. It performs no policy: the
 * Hub decides grants (see `eidoverse-mcpl-config.ts`) and wake treatment (see
 * `eidoverse-wake-filter.ts`); advertisement is never authorization.
 */

import type { EidoversePingKind } from "./eidoverse-wake-filter.js";

/** JSON-RPC method and notification names used against the door. */
export const MCPL_METHOD = {
  initialize: "initialize",
  initialized: "notifications/initialized",
  featureSetsUpdate: "featureSets/update",
  toolsCall: "tools/call",
  channelsRegister: "channels/register",
  channelsChanged: "channels/changed",
  channelsList: "channels/list",
  channelsOpen: "channels/open",
  channelsClose: "channels/close",
  channelsPublish: "channels/publish",
  channelsIncoming: "channels/incoming",
  channelsTyping: "channels/typing",
  channelsAcknowledge: "channels/acknowledge",
  channelsOutgoingChunk: "channels/outgoing/chunk",
  channelsOutgoingComplete: "channels/outgoing/complete",
} as const;

/** MCP protocol revision the door answers with (`net-server.ts` handshake). */
export const MCPL_PROTOCOL_VERSION = "2024-11-05";

/** MCPL specification revision this host declares in its own manifest. */
export const MCPL_HOST_VERSION = "0.5";

/** JSON-RPC error codes this host emits. Mirrors `mcpl-core` `types.d.ts`. */
export const MCPL_ERROR = {
  invalidParams: -32_602,
  methodNotFound: -32_601,
} as const;

/**
 * The closed §6.2 capability-path vocabulary the Hub can grant. A value outside
 * this list is not a capability path and must never be sent.
 */
export const MCPL_CAPABILITY = {
  tools: "tools",
  channelsRegister: "channels.register",
  channelsLifecycle: "channels.lifecycle",
  channelsPublish: "channels.publish",
  channelsIncoming: "channels.incoming",
  channelsStreaming: "channels.streaming",
  channelsAcknowledge: "channels.acknowledge",
  channelsTyping: "channels.typing",
} as const;

export type McplCapabilityPath = (typeof MCPL_CAPABILITY)[keyof typeof MCPL_CAPABILITY];

/**
 * The door's declared feature sets and the capability paths each one needs,
 * mirrored from the Eidoverse `declaration.ts` FEATURE_SETS table.
 *
 * A feature set is disabled WHOLE when any capability it names is denied, so
 * this table exists to make the Hub's grant derivable from the operator's
 * feature-set selection rather than hand-listed. `eidoverse.typing` is declared
 * here for completeness and is never selected by default: it draws only on
 * `channels.streaming`, so it can be refused without touching world presence.
 */
export const EIDOVERSE_FEATURE_SET_USES: Readonly<
  Record<string, readonly McplCapabilityPath[]>
> = Object.freeze({
  "eidoverse.world": Object.freeze([
    MCPL_CAPABILITY.channelsRegister,
    MCPL_CAPABILITY.channelsLifecycle,
    MCPL_CAPABILITY.channelsPublish,
    MCPL_CAPABILITY.channelsIncoming,
  ]),
  "eidoverse.embodiment": Object.freeze([MCPL_CAPABILITY.tools]),
  "eidoverse.travel": Object.freeze([
    MCPL_CAPABILITY.channelsLifecycle,
    MCPL_CAPABILITY.tools,
  ]),
  "eidoverse.typing": Object.freeze([MCPL_CAPABILITY.channelsStreaming]),
});

/** Reserved cross-platform tag core (§16.2) the Hub routes on. */
export const MCPL_CHAT_TAG = {
  addressed: "chat:addressed",
  mention: "chat:mention",
  dm: "chat:dm",
  ambient: "chat:ambient",
} as const;

/** The Eidoverse producer namespace (§16.1). */
export const EIDOVERSE_TAG = {
  whisper: "eidoverse:whisper",
  approach: "eidoverse:approach",
  depart: "eidoverse:depart",
  reach: "eidoverse:reach",
  touch: "eidoverse:touch",
  act: "eidoverse:act",
  presence: "eidoverse:presence",
  activityDigest: "eidoverse:activity-digest",
  weather: "eidoverse:weather",
  catchup: "eidoverse:catchup",
  worldChange: "eidoverse:world-change",
  particles: "eidoverse:particles",
} as const;

export type JsonRpcId = number | string;

export interface JsonRpcRequestFrame {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseFrame {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotificationFrame {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcFrame =
  | { kind: "request"; request: JsonRpcRequestFrame }
  | { kind: "response"; response: JsonRpcResponseFrame }
  | { kind: "notification"; notification: JsonRpcNotificationFrame };

export interface McplTextContent {
  type: "text";
  text: string;
}

export interface McplChannelDescriptor {
  id: string;
  type?: string;
  label?: string;
  direction?: string;
  address?: unknown;
  metadata?: unknown;
  initiallyOpen?: boolean;
}

export interface McplChannelsRegisterParams {
  channels: McplChannelDescriptor[];
}

export interface McplChannelDescriptorResult {
  id: string;
  accepted: boolean;
  reason?: string;
}

export interface McplChannelsRegisterResult {
  results: McplChannelDescriptorResult[];
}

export interface McplChannelsChangedParams {
  added?: McplChannelDescriptor[];
  removed?: string[];
  updated?: McplChannelDescriptor[];
}

export interface McplIncomingChannelMessage {
  channelId: string;
  messageId: string;
  author: { id: string; name: string };
  timestamp: string;
  content: Array<{ type: string; text?: string }>;
  tags?: string[];
  metadata?: unknown;
}

export interface McplChannelsIncomingParams {
  messages: McplIncomingChannelMessage[];
}

export interface McplIncomingMessageResult {
  messageId: string;
  accepted: boolean;
  conversationId?: string;
}

export interface McplChannelsIncomingResult {
  results: McplIncomingMessageResult[];
}

export interface McplFeatureSetsUpdateParams {
  enabled?: string[];
  effectiveCapabilities?: string[];
}

/** The host's own `capabilities.experimental.mcpl` manifest. */
export interface McplHostManifest {
  version: string;
  pushEvents: false;
  channels: {
    register: boolean;
    lifecycle: boolean;
    publish: boolean;
    incoming: boolean;
    streaming: boolean;
    acknowledge: boolean;
    typing: boolean;
  };
  featureSets: true;
}

/**
 * Expand a feature-set selection into the effective capability allowlist.
 *
 * `effectiveCapabilities` is the sole normative allowlist: every path not
 * present is denied. An unknown feature-set name contributes nothing rather
 * than widening the grant.
 */
export function effectiveCapabilitiesForFeatureSets(
  featureSets: readonly string[],
): McplCapabilityPath[] {
  const granted = new Set<McplCapabilityPath>();
  for (const name of featureSets) {
    for (const path of EIDOVERSE_FEATURE_SET_USES[name] ?? []) granted.add(path);
  }
  return [...granted];
}

/** The host manifest implied by a grant: advertise only what was granted. */
export function hostManifestForCapabilities(
  effectiveCapabilities: readonly McplCapabilityPath[],
): McplHostManifest {
  const has = (path: McplCapabilityPath): boolean => effectiveCapabilities.includes(path);
  return {
    version: MCPL_HOST_VERSION,
    pushEvents: false,
    channels: {
      register: has(MCPL_CAPABILITY.channelsRegister),
      lifecycle: has(MCPL_CAPABILITY.channelsLifecycle),
      publish: has(MCPL_CAPABILITY.channelsPublish),
      incoming: has(MCPL_CAPABILITY.channelsIncoming),
      streaming: has(MCPL_CAPABILITY.channelsStreaming),
      acknowledge: has(MCPL_CAPABILITY.channelsAcknowledge),
      typing: has(MCPL_CAPABILITY.channelsTyping),
    },
    featureSets: true,
  };
}

/**
 * Parse one newline-delimited JSON-RPC frame. Returns null for anything that is
 * not a well-formed JSON-RPC 2.0 message: a malformed frame is dropped, never
 * guessed at, and never promoted into a wake.
 */
export function parseJsonRpcFrame(line: string): JsonRpcFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") return null;
  const hasId = typeof value.id === "number" || typeof value.id === "string";
  if (typeof value.method === "string") {
    if (!hasId) {
      return {
        kind: "notification",
        notification: {
          jsonrpc: "2.0",
          method: value.method,
          ...(value.params === undefined ? {} : { params: value.params }),
        },
      };
    }
    return {
      kind: "request",
      request: {
        jsonrpc: "2.0",
        id: value.id as JsonRpcId,
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
      },
    };
  }
  if (!hasId) return null;
  if (!("result" in value) && !("error" in value)) return null;
  const error = isRecord(value.error) && typeof value.error.code === "number"
    ? {
        code: value.error.code,
        message: typeof value.error.message === "string" ? value.error.message : "",
        ...(value.error.data === undefined ? {} : { data: value.error.data }),
      }
    : undefined;
  return {
    kind: "response",
    response: {
      jsonrpc: "2.0",
      id: value.id as JsonRpcId,
      ...(error ? { error } : { result: value.result }),
    },
  };
}

/**
 * Extract the single text block from an MCP `tools/call` result, refusing an
 * error result or any shape that is not exactly one text block. Identical
 * contract to the Phase 1 stdio client's reader so both transports fail the
 * same way.
 */
export function extractSingleToolText(result: unknown): string {
  if (!isRecord(result) || result.isError === true) throw new Error("invalid MCP tool result");
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("invalid MCP tool result");
  const block = content[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("invalid MCP tool result");
  }
  return block.text;
}

/** Join every text block of an incoming channel message into its ping line. */
export function incomingMessageText(message: McplIncomingChannelMessage): string {
  return message.content
    .filter((block): block is McplTextContent =>
      isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface McplClassificationOptions {
  /**
   * Whether a replayed (`eidoverse:catchup`) message keeps its original
   * addressing. Default false: a reconnect replays up to ten missed mentions
   * at once, and waking a turn for each of them turns every reconnect into a
   * burst of inference. False classifies the whole replay as `catchup`, which
   * the Hub wake table suppresses.
   */
  catchupKeepsAddressing: boolean;
}

/**
 * Classify one `channels/incoming` message into the Hub's wake vocabulary from
 * its declared tags.
 *
 * Tag-based, not text-based: MCPL carries the producer's own semantic tags, and
 * the `*`-prefixed delivery text differs from the plain-MCP `pending_pings`
 * line the Phase 1 classifier matches. Unknown or untagged traffic returns null
 * and never becomes a wake.
 */
export function classifyMcplIncomingMessage(
  message: McplIncomingChannelMessage,
  options: McplClassificationOptions,
): EidoversePingKind | null {
  const tags = new Set((message.tags ?? []).filter((tag): tag is string => typeof tag === "string"));
  if (tags.size === 0) return null;
  if (tags.has(EIDOVERSE_TAG.catchup) && !options.catchupKeepsAddressing) return "catchup";
  if (tags.has(EIDOVERSE_TAG.whisper)) return "whisper";
  if (tags.has(EIDOVERSE_TAG.approach)) return "approach";
  if (tags.has(EIDOVERSE_TAG.reach)) return "reach";
  if (tags.has(EIDOVERSE_TAG.touch)) return "touch";
  if (tags.has(EIDOVERSE_TAG.depart)) return "depart";
  if (tags.has(EIDOVERSE_TAG.presence)) return "presence";
  if (tags.has(EIDOVERSE_TAG.activityDigest)) return "digest";
  if (tags.has(MCPL_CHAT_TAG.dm)) return "whisper";
  if (tags.has(MCPL_CHAT_TAG.mention)) return "mention";
  if (tags.has(EIDOVERSE_TAG.act)
    || tags.has(EIDOVERSE_TAG.weather)
    || tags.has(EIDOVERSE_TAG.worldChange)
    || tags.has(EIDOVERSE_TAG.particles)) {
    return "say";
  }
  if (tags.has(MCPL_CHAT_TAG.addressed)) return "mention";
  if (tags.has(MCPL_CHAT_TAG.ambient)) return "say";
  return null;
}

/** Read the world name a door channel descriptor is addressed to. */
export function descriptorWorldName(descriptor: McplChannelDescriptor): string | null {
  const address = descriptor.address;
  if (isRecord(address) && typeof address.world === "string" && address.world) {
    return address.world;
  }
  const id = descriptor.id;
  return id.startsWith("world:") && id.length > "world:".length ? id.slice("world:".length) : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
