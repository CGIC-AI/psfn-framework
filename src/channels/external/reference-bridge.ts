// ── Reference external channel bridge (psfn-framework-pus8m) ──
//
// The smallest complete bridge: an MCP client that speaks protocol version 1
// to one adapter endpoint, plus a loopback platform — an in-memory "messaging
// system" — so tests and new bridge authors can see the whole round trip. A
// real bridge replaces `LoopbackPlatform` with its messaging API (SMS gateway,
// WhatsApp, ...) and keeps the client and pump shape.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isRecord } from '../../shared/utils/types.js';
import {
  EXTERNAL_CHANNEL_PROTOCOL_VERSION,
  EXTERNAL_CHANNEL_TOOL_NAMES,
  type ExternalChannelHelloResult,
  type ExternalChannelInboundMessage,
  type ExternalChannelInboundResult,
  type ExternalChannelOutboundMessage,
  type ExternalChannelPullResult,
  type ExternalChannelStatus,
} from './protocol.js';

export interface ReferenceBridgeOptions {
  endpoint: URL;
  token: string;
  name: string;
  version: string;
  /** Per-call deadline; should exceed the adapter's advertised turnTimeoutMs. */
  callTimeoutMs: number;
}

/** Thin, typed protocol client over the adapter's MCP endpoint. */
export class ReferenceExternalChannelBridge {
  readonly #options: ReferenceBridgeOptions;
  #client: Client | undefined;

  constructor(options: ReferenceBridgeOptions) {
    this.#options = options;
  }

  /** Connects and performs the version handshake; throws on any mismatch. */
  async connect(): Promise<ExternalChannelHelloResult> {
    const client = new Client({ name: this.#options.name, version: this.#options.version });
    await client.connect(new StreamableHTTPClientTransport(this.#options.endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${this.#options.token}` } },
    }));
    this.#client = client;
    // The adapter is a remote peer: its answer is checked, not trusted by type.
    const hello = await this.#call<Record<string, unknown>>(EXTERNAL_CHANNEL_TOOL_NAMES.hello, {
      bridge: { name: this.#options.name, version: this.#options.version },
    });
    if (hello.protocolVersion !== EXTERNAL_CHANNEL_PROTOCOL_VERSION) {
      throw new Error(`Adapter speaks protocol ${String(hello.protocolVersion)}`);
    }
    return hello as unknown as ExternalChannelHelloResult;
  }

  async deliverInbound(message: ExternalChannelInboundMessage): Promise<ExternalChannelInboundResult> {
    return await this.#call(EXTERNAL_CHANNEL_TOOL_NAMES.inbound, { message });
  }

  async pullOutbound(maxItems?: number): Promise<ExternalChannelOutboundMessage[]> {
    const result = await this.#call<ExternalChannelPullResult>(
      EXTERNAL_CHANNEL_TOOL_NAMES.pullOutbound,
      maxItems === undefined ? {} : { maxItems },
    );
    return result.messages;
  }

  async reportHealth(status: 'ok' | 'degraded', detail?: string): Promise<ExternalChannelStatus> {
    return await this.#call(EXTERNAL_CHANNEL_TOOL_NAMES.health, { status, ...(detail ? { detail } : {}) });
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  async #call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = this.#client;
    if (!client) throw new Error('Reference bridge is not connected');
    const result = await client.callTool(
      { name, arguments: { protocolVersion: EXTERNAL_CHANNEL_PROTOCOL_VERSION, ...args } },
      { timeout: this.#options.callTimeoutMs },
    );
    if (result.isError === true || !isRecord(result.structuredContent)) {
      const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
      const detail = isRecord(first) && typeof first.text === 'string' ? first.text : 'no structured result';
      throw new Error(`Adapter refused ${name}: ${detail}`);
    }
    return result.structuredContent as T;
  }
}

/** In-memory stand-in for a messaging system: users type, the bridge relays. */
export class LoopbackPlatform {
  readonly delivered: ExternalChannelOutboundMessage[] = [];
  readonly replies: Array<{ conversationId: string; text: string }> = [];
  #sequence = 0;

  constructor(private readonly bridge: ReferenceExternalChannelBridge) {}

  /** A platform user sends a message; the companion reply lands in `replies`. */
  async userSays(input: {
    conversationId: string;
    conversationKind: 'direct' | 'group';
    senderId: string;
    senderName: string;
    text: string;
  }): Promise<ExternalChannelInboundResult> {
    this.#sequence += 1;
    const result = await this.bridge.deliverInbound({ id: `loopback-${this.#sequence}`, ...input });
    if (result.status === 'replied') this.replies.push(result.reply);
    return result;
  }

  /** One outbound pump pass: drains queued companion messages into `delivered`. */
  async pumpOutbound(): Promise<number> {
    const messages = await this.bridge.pullOutbound();
    this.delivered.push(...messages);
    return messages.length;
  }
}

