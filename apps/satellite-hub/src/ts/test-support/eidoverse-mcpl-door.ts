/**
 * A local MCPL door, hand-written for tests.
 *
 * No runnable Eidoverse world exists in this repository or in CI — the real
 * sequencer needs a separate unvendored asset checkout and, for vision, a live
 * GPU renderer. So the transport is proved against a double that speaks the
 * exact frames the real door does: the literal method names and payload shapes
 * of `@animalabs/mcpl-core` 0.3.0, the `initialize` /
 * `notifications/initialized` / `featureSets/update` opening the door requires
 * before it will push anything, the server-to-host `channels/register` and
 * `channels/changed` PREPARE Requests, and the `travel` tool's synchronous
 * arrival text.
 *
 * It is a test fixture, not a conformance implementation: it models the
 * behaviors the Hub client must survive, not the whole world.
 */

import { WebSocketServer, type WebSocket } from "ws";

interface DoorFrame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface EidoverseMcplDoorOptions {
  /** World the connection attaches to first. */
  world: string;
  /** Token values the door admits. Anything else is refused at dial. */
  tokens: readonly string[];
  /** Worlds `travel` may reach. A destination outside the list is refused. */
  travelWorlds?: readonly string[];
  /** Delay before the `travel` tool answers, for exercising request timeouts. */
  travelDelayMs?: number;
  /** Text the `look` tool returns. */
  lookText?: string;
  /** Drop the socket immediately after the policy receipt, once. */
  dropAfterFirstPolicy?: boolean;
}

interface DoorConnection {
  socket: WebSocket;
  grant: Set<string>;
  world: string;
  epoch: number;
  nextId: number;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
}

export class EidoverseMcplDoor {
  /** `effectiveCapabilities` from each `featureSets/update` the door received. */
  readonly grants: string[][] = [];
  /** Feature-set names each policy message enabled. */
  readonly enabledFeatureSets: string[][] = [];
  /** Destination world of every PREPARE the door asked about. */
  readonly prepared: string[] = [];
  /** Whether the host accepted each PREPARE, in the same order. */
  readonly preparedAccepted: boolean[] = [];
  /** Text of every accepted `say`. */
  readonly said: string[] = [];
  /** Dial URLs the door has admitted. */
  readonly admittedTokens: string[] = [];
  /** Dial attempts the door refused for a bad token. */
  refusedDials = 0;
  connections = 0;

  private connection: DoorConnection | null = null;
  private policyDropsRemaining: number;

  private constructor(
    private readonly server: WebSocketServer,
    readonly url: string,
    private readonly options: EidoverseMcplDoorOptions,
  ) {
    this.policyDropsRemaining = options.dropAfterFirstPolicy ? 1 : 0;
    this.server.on("connection", (socket, request) => this.admit(socket, request.url ?? ""));
  }

  static async start(options: EidoverseMcplDoorOptions): Promise<EidoverseMcplDoor> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Eidoverse MCPL door did not bind a TCP port");
    }
    return new EidoverseMcplDoor(server, `ws://127.0.0.1:${address.port}/mcpl`, options);
  }

  /** The world the current attachment is in. */
  currentWorld(): string {
    return this.connection?.world ?? this.options.world;
  }

  /** Whether a live host connection has completed the handshake. */
  get connected(): boolean {
    return this.connection !== null;
  }

  /** Wait until a host has finished the handshake and holds a grant. */
  async waitForHandshake(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connection) {
      if (Date.now() > deadline) throw new Error("Eidoverse MCPL door saw no host handshake");
      await delay(5);
    }
  }

  /** Send the world channel registration the real door sends after policy. */
  async registerChannel(): Promise<unknown> {
    return this.request("channels/register", { channels: [this.descriptor()] });
  }

  /** Push one `channels/incoming` batch and return the host's itemized answer. */
  async deliver(messages: ReadonlyArray<Record<string, unknown>>): Promise<unknown> {
    if (!this.connection?.grant.has("channels.incoming")) {
      throw new Error("channels.incoming is not granted");
    }
    return this.request("channels/incoming", { messages: [...messages] });
  }

  /** Build one delivery in the door's own rendering, with its producer tags. */
  message(input: {
    text: string;
    tags: readonly string[];
    author?: { id: string; name: string };
    messageId?: string;
  }): Record<string, unknown> {
    return {
      channelId: `world:${this.currentWorld()}`,
      messageId: input.messageId ?? `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      author: input.author ?? { id: "world", name: this.currentWorld() },
      timestamp: new Date().toISOString(),
      content: [{ type: "text", text: input.text }],
      tags: [...input.tags],
    };
  }

  /** Drop the live socket without closing the door, as a network cut would. */
  dropConnection(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.socket.terminate();
  }

  async close(): Promise<void> {
    this.connection?.socket.terminate();
    this.connection = null;
    await new Promise<void>((resolve) => { this.server.close(() => { resolve(); }); });
  }

  private admit(socket: WebSocket, requestUrl: string): void {
    const token = new URL(requestUrl, "ws://127.0.0.1").searchParams.get("token");
    if (!token || !this.options.tokens.includes(token)) {
      this.refusedDials += 1;
      socket.close(1008, "identity token refused");
      return;
    }
    this.admittedTokens.push(token);
    this.connections += 1;
    const connection: DoorConnection = {
      socket,
      grant: new Set<string>(),
      world: this.options.world,
      epoch: 1,
      nextId: 1,
      pending: new Map(),
    };
    socket.on("message", (data: unknown) => {
      void this.handleFrame(connection, String(data));
    });
    socket.on("close", () => {
      if (this.connection === connection) this.connection = null;
      for (const [, pending] of connection.pending) {
        pending.reject(new Error("door connection closed"));
      }
      connection.pending.clear();
    });
  }

  private async handleFrame(connection: DoorConnection, raw: string): Promise<void> {
    let frame: DoorFrame;
    try {
      frame = JSON.parse(raw) as DoorFrame;
    } catch {
      return;
    }
    if (frame.method === undefined) {
      if (typeof frame.id !== "number") return;
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      connection.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message));
      else pending.resolve(frame.result);
      return;
    }
    const params = frame.params ?? {};
    switch (frame.method) {
      case "initialize":
        this.respond(connection, frame.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, experimental: { mcpl: MANIFEST } },
          serverInfo: { name: "eidoverse-worlds", version: "0.1.0" },
        });
        return;
      case "notifications/initialized":
        return;
      case "featureSets/update": {
        const effective = Array.isArray(params.effectiveCapabilities)
          ? (params.effectiveCapabilities as unknown[]).map(String)
          : [];
        const enabled = Array.isArray(params.enabled)
          ? (params.enabled as unknown[]).map(String)
          : [];
        connection.grant = new Set(effective);
        this.grants.push(effective);
        this.enabledFeatureSets.push(enabled);
        this.respond(connection, frame.id, { accepted: true, mode: "full", notes: [] });
        this.connection = connection;
        if (this.policyDropsRemaining > 0) {
          this.policyDropsRemaining -= 1;
          setTimeout(() => {
            if (this.connection === connection) this.connection = null;
            connection.socket.terminate();
          }, 5).unref();
        }
        return;
      }
      case "tools/call":
        await this.handleTool(connection, frame);
        return;
      case "channels/publish": {
        if (!connection.grant.has("channels.publish")) {
          this.respondError(connection, frame.id, -32_003, "channels.publish not granted");
          return;
        }
        this.respond(connection, frame.id, { delivered: true });
        return;
      }
      default:
        this.respondError(connection, frame.id, -32_601, `Method not found: ${frame.method}`);
    }
  }

  private async handleTool(connection: DoorConnection, frame: DoorFrame): Promise<void> {
    const params = frame.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!connection.grant.has("tools")) {
      this.respondError(connection, frame.id, -32_601, "tools are not granted to this host");
      return;
    }
    if (name === "look") {
      this.text(connection, frame.id, this.options.lookText ?? "A sunlit atrium.");
      return;
    }
    if (name === "say") {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        this.errorText(connection, frame.id, "say refused: text is required");
        return;
      }
      this.said.push(text);
      this.text(connection, frame.id, "said");
      return;
    }
    if (name === "travel") {
      await this.handleTravel(connection, frame, String(args.world ?? ""));
      return;
    }
    this.errorText(connection, frame.id, `unknown tool: ${name}`);
  }

  private async handleTravel(
    connection: DoorConnection,
    frame: DoorFrame,
    target: string,
  ): Promise<void> {
    if (this.options.travelDelayMs) await delay(this.options.travelDelayMs);
    if (!/^[a-z0-9_-]{1,64}$/.test(target)) {
      this.errorText(connection, frame.id, `travel refused: "${target}" is not a valid world name`);
      return;
    }
    if (target === connection.world) {
      this.text(connection, frame.id, `Already in "${target}".`);
      return;
    }
    if (!connection.grant.has("channels.lifecycle")) {
      this.errorText(connection, frame.id, "travel refused: channels.lifecycle is not granted");
      return;
    }
    if (!(this.options.travelWorlds ?? []).includes(target)) {
      this.errorText(connection, frame.id, `travel refused: "${target}" is not in your join policy`);
      return;
    }
    if (connection.grant.has("channels.register")) {
      this.prepared.push(target);
      let accepted = false;
      try {
        const answer = await Promise.race([
          this.request("channels/changed", {
            added: [{
              id: `world:${target}`,
              type: "world",
              label: `eidoverse — ${target}`,
              direction: "bidirectional",
              address: { world: target },
              initiallyOpen: true,
              metadata: { epoch: connection.epoch + 1 },
            }],
          }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => { reject(new Error("host did not answer channels/changed")); },
              PREPARE_BUDGET_MS,
            );
            timer.unref();
          }),
        ]) as { results?: Array<{ id: string; accepted?: boolean }> } | undefined;
        const mine = answer?.results?.find((entry) => entry.id === `world:${target}`);
        accepted = mine ? mine.accepted !== false : true;
      } catch {
        accepted = false;
      }
      this.preparedAccepted.push(accepted);
      if (!accepted) {
        this.errorText(connection, frame.id, `travel refused: host declined channel world:${target}`);
        return;
      }
    }
    const leaving = `world:${connection.world}`;
    connection.world = target;
    connection.epoch += 1;
    this.notify(connection, "channels/changed", { removed: [leaving] });
    this.text(
      connection,
      frame.id,
      `Arrived in "${target}" (attachment ${connection.epoch}). Your identity, avatar and `
      + "attention settings came with you; your held pose and posture did not (they are "
      + "world-local). Your chat cursor starts fresh here. Use `look` to see where you are.",
    );
  }

  private descriptor(): Record<string, unknown> {
    const connection = this.connection;
    const world = connection?.world ?? this.options.world;
    return {
      id: `world:${world}`,
      type: "world",
      label: `eidoverse — ${world}`,
      direction: "bidirectional",
      address: { world },
      initiallyOpen: true,
      metadata: { epoch: connection?.epoch ?? 1 },
    };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error("no live host connection"));
    const id = connection.nextId;
    connection.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      connection.pending.set(id, { resolve, reject });
      connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(
    connection: DoorConnection,
    method: string,
    params: Record<string, unknown>,
  ): void {
    connection.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private respond(connection: DoorConnection, id: DoorFrame["id"], result: unknown): void {
    if (id === undefined) return;
    connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(
    connection: DoorConnection,
    id: DoorFrame["id"],
    code: number,
    message: string,
  ): void {
    if (id === undefined) return;
    connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private text(connection: DoorConnection, id: DoorFrame["id"], value: string): void {
    this.respond(connection, id, { content: [{ type: "text", text: value }] });
  }

  private errorText(connection: DoorConnection, id: DoorFrame["id"], value: string): void {
    this.respond(connection, id, { content: [{ type: "text", text: value }], isError: true });
  }
}

/** The door's PREPARE budget: an unanswered question is a decline. */
const PREPARE_BUDGET_MS = 5_000;

const MANIFEST = {
  version: "0.5",
  pushEvents: false,
  channels: {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    streaming: true,
    acknowledge: false,
    typing: false,
  },
  featureSets: {
    "eidoverse.world": {
      description: "Embodied presence in a world.",
      uses: ["channels.register", "channels.lifecycle", "channels.publish", "channels.incoming"],
    },
    "eidoverse.embodiment": { description: "The body's hands and senses as tools.", uses: ["tools"] },
    "eidoverse.travel": {
      description: "Walking between the worlds this door fronts.",
      uses: ["channels.lifecycle", "tools"],
    },
    "eidoverse.typing": { description: "Typing dots.", uses: ["channels.streaming"] },
  },
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
