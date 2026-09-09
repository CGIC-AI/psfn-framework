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
 *
 * PREPARE is a proposal, not an outcome. The door confirms a transition with
 * the NOTIFICATION form of `channels/changed` (the COMMIT phase), which
 * `commit()` applies: the outstanding proposal becomes real, `added` and
 * `updated` descriptors are recorded, and `removed` ids are evicted — in that
 * order, so a COMMIT that retires the very channel it proposed still ends up
 * deleted. Without that phase the tracked set only ever grows: the world the
 * body left stays listed forever and `channels/list` answers for a channel the
 * door has already torn down. One transition is in flight at a time, so a
 * PREPARE supersedes a proposal that never committed rather than accumulating
 * beside it.
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
  /** Channels the door has committed to: registered, or confirmed by COMMIT. */
  private readonly channels = new Map<string, McplChannelDescriptor>();
  /** The transition proposed by the latest PREPARE and not yet committed. */
  private prepared = new Map<string, McplChannelDescriptor>();
  private latestChannelId: string | null = null;

  constructor(private readonly logger?: EidoverseMcplResponderLogger) {}

  /** Channel ids the door has registered or committed and this host accepted. */
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
    const descriptor = this.prepared.get(channelId) ?? this.channels.get(channelId);
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

  /**
   * Apply the COMMIT phase of one transition, delivered as a notification.
   *
   * A notification has no reply, so a malformed payload is dropped with a
   * content-free warning and leaves the tracked set exactly as it was: the
   * belief the Hub already held is closer to the truth than a half-applied one.
   */
  commit(params: unknown): void {
    if (!isRecord(params)) {
      this.malformedCommit();
      return;
    }
    const added = params.added === undefined ? [] : parseDescriptors(params.added);
    const updated = params.updated === undefined ? [] : parseDescriptors(params.updated);
    const removed = params.removed === undefined ? [] : parseRemovedIds(params.removed);
    if (!added || !updated || !removed) {
      this.malformedCommit();
      return;
    }
    // The proposal this COMMIT confirms. The door names only what it retires,
    // so promoting the outstanding proposal — not just `added` — is what keeps
    // the world just travelled to tracked.
    for (const [id, descriptor] of this.prepared) this.channels.set(id, descriptor);
    this.prepared = new Map();
    for (const descriptor of added) {
      this.channels.set(descriptor.id, descriptor);
      this.latestChannelId = descriptor.id;
    }
    for (const descriptor of updated) {
      if (this.channels.has(descriptor.id)) this.channels.set(descriptor.id, descriptor);
    }
    for (const id of removed) {
      this.channels.delete(id);
      if (this.latestChannelId === id) this.latestChannelId = null;
    }
    if (this.latestChannelId === null) {
      this.latestChannelId = [...this.channels.keys()].at(-1) ?? null;
    }
  }

  private applyChanged(params: unknown): EidoverseMcplResponse {
    if (!isRecord(params)) return this.malformed("channels/changed");
    const removed = params.removed;
    if (removed !== undefined) {
      const ids = parseRemovedIds(removed);
      if (!ids) return this.malformed("channels/changed");
      for (const id of ids) {
        this.channels.delete(id);
        this.prepared.delete(id);
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
    return this.proposeDescriptors(params.added);
  }

  /**
   * Accept every registered descriptor. The itemized result form is used even
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

  /**
   * Accept a PREPARE's descriptors as a proposal, in the same itemized form.
   * They become current — a publish issued between PREPARE and COMMIT must
   * target the channel the door is moving to — but they are not committed
   * state, and a proposal the door never commits is superseded by the next one
   * rather than kept forever.
   */
  private proposeDescriptors(value: unknown): EidoverseMcplResponse {
    const parsed = parseDescriptors(value);
    if (!parsed) return this.malformed("added");
    this.prepared = new Map();
    const results: McplChannelDescriptorResult[] = [];
    for (const descriptor of parsed) {
      this.prepared.set(descriptor.id, descriptor);
      this.latestChannelId = descriptor.id;
      results.push({ id: descriptor.id, accepted: true });
    }
    return { result: { results } };
  }

  private malformed(field: string): EidoverseMcplResponse {
    this.logger?.warn(`Eidoverse MCPL door sent a malformed ${field} request`);
    return { error: { code: MCPL_ERROR.invalidParams, message: `malformed ${field}` } };
  }

  private malformedCommit(): void {
    this.logger?.warn("Eidoverse MCPL door sent a malformed channels/changed notification");
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

function parseRemovedIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((id) => typeof id !== "string" || !id)) return null;
  return value as string[];
}
