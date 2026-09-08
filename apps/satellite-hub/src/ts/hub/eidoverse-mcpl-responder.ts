/**
 * Inbound-request policy for the Hub's MCPL door connection.
 *
 * An MCPL door is a bidirectional JSON-RPC peer: it registers its world channel
 * with a server-to-host `channels/register` Request, and it asks permission for
 * every world transition with the Request form of `channels/changed` (the
 * PREPARE phase) — including transitions the Hub itself asked for with the
 * `travel` tool. A host that does not answer, or answers late, is treated as
 * DECLINING, so this responder is deliberately synchronous and allocates
 * nothing that can block: the answer is written on the same turn the request is
 * read, well inside the door's five-second budget.
 *
 * The policy itself is small and stated once here: every transition this Hub
 * will ever be asked about is one it requested, so PREPARE is always accepted.
 * There is no scenario in which the Hub vetoes its own travel. What the
 * responder does NOT do is invent authority: an unknown method is refused, a
 * malformed descriptor set is refused, and nothing it answers widens the
 * capability grant the Hub issued at handshake.
 */

import {
  descriptorWorldName,
  isRecord,
  MCPL_ERROR,
  MCPL_METHOD,
  type JsonRpcRequestFrame,
  type McplChannelDescriptor,
  type McplChannelDescriptorResult,
} from "./eidoverse-mcpl-wire.js";

export interface EidoverseMcplResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

export interface EidoverseMcplResponderLogger {
  warn(message: string): void;
}

/**
 * Tracks the door channels the Hub has accepted and answers the door's inbound
 * requests. Channel state is observation, never authority: the world the Hub
 * believes it is in is confirmed by the `travel` tool's own return value.
 */
export class EidoverseMcplResponder {
  private readonly channels = new Map<string, McplChannelDescriptor>();
  private latestChannelId: string | null = null;

  constructor(private readonly logger?: EidoverseMcplResponderLogger) {}

  /** Channel ids the door has registered and this host accepted. */
  channelIds(): readonly string[] {
    return [...this.channels.keys()];
  }

  /** The channel most recently registered or prepared, if any. */
  currentChannelId(): string | null {
    return this.latestChannelId;
  }

  /** The world name carried by the current channel descriptor, if any. */
  currentWorldName(): string | null {
    const channelId = this.latestChannelId;
    if (!channelId) return null;
    const descriptor = this.channels.get(channelId);
    return descriptor ? descriptorWorldName(descriptor) : null;
  }

  /**
   * Produce the response for one inbound door request. `channels/incoming` is
   * deliberately absent: it carries wake authority and is answered by the
   * client, which owns the wake path.
   */
  handle(request: JsonRpcRequestFrame): EidoverseMcplResponse {
    switch (request.method) {
      case MCPL_METHOD.channelsRegister:
        return this.acceptDescriptors(request.params, "channels");
      case MCPL_METHOD.channelsChanged:
        return this.applyChanged(request.params);
      case MCPL_METHOD.channelsList:
        return { result: { channels: [...this.channels.values()] } };
      default:
        return {
          error: {
            code: MCPL_ERROR.methodNotFound,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  }

  private applyChanged(params: unknown): EidoverseMcplResponse {
    if (!isRecord(params)) return this.malformed("channels/changed");
    const removed = params.removed;
    if (removed !== undefined) {
      if (!Array.isArray(removed) || removed.some((id) => typeof id !== "string")) {
        return this.malformed("channels/changed");
      }
      for (const id of removed as string[]) {
        this.channels.delete(id);
        if (this.latestChannelId === id) this.latestChannelId = null;
      }
    }
    const updated = params.updated;
    if (updated !== undefined) {
      const parsed = parseDescriptors(updated);
      if (!parsed) return this.malformed("channels/changed");
      for (const descriptor of parsed) {
        if (this.channels.has(descriptor.id)) this.channels.set(descriptor.id, descriptor);
      }
    }
    if (params.added === undefined) return { result: { results: [] } };
    return this.acceptDescriptors(params, "added");
  }

  /**
   * Accept every proposed descriptor. The itemized result form is used even
   * though this host accepts unconditionally: the door reads per-descriptor
   * results, and an unitemized answer would make a later narrowing of this
   * policy unexpressible.
   */
  private acceptDescriptors(params: unknown, field: string): EidoverseMcplResponse {
    if (!isRecord(params)) return this.malformed(field);
    const parsed = parseDescriptors(params[field]);
    if (!parsed) return this.malformed(field);
    const results: McplChannelDescriptorResult[] = [];
    for (const descriptor of parsed) {
      this.channels.set(descriptor.id, descriptor);
      this.latestChannelId = descriptor.id;
      results.push({ id: descriptor.id, accepted: true });
    }
    return { result: { results } };
  }

  private malformed(field: string): EidoverseMcplResponse {
    this.logger?.warn(`Eidoverse MCPL door sent a malformed ${field} request`);
    return { error: { code: MCPL_ERROR.invalidParams, message: `malformed ${field}` } };
  }
}

function parseDescriptors(value: unknown): McplChannelDescriptor[] | null {
  if (!Array.isArray(value)) return null;
  const descriptors: McplChannelDescriptor[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return null;
    descriptors.push(entry as unknown as McplChannelDescriptor);
  }
  return descriptors;
}
