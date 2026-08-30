import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PENDING_PINGS_POLL_INTERVAL_MS = 2_000;
const DEFAULT_AMBIENT_SAY_DEBOUNCE_MS = 180_000;
export const EIDOVERSE_SAY_MAX_TEXT_LENGTH = 4_000;

export interface EidoverseMcpConfig {
  command: string;
  args: string[];
  worldUrl: string;
  tokenRef: string;
  worldName: string;
  agentName: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectMaxAttempts: number;
  requestTimeoutMs: number;
  pendingPingsPollIntervalMs: number;
  ambientSayDebounceMs: number;
}

export interface EidoverseMcpLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type EidoverseCredentialResolver = (reference: string) => Promise<string>;

type EidoverseToolRequest =
  | { name: "look"; arguments: Record<string, never> }
  | { name: "say"; arguments: { text: string } }
  | { name: "pending_pings"; arguments: Record<string, never> };

interface EidoverseMcpSession {
  connect(): Promise<void>;
  request(request: EidoverseToolRequest): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface EidoverseMcpClientOptions {
  logger?: EidoverseMcpLogger;
}

const SILENT_LOGGER: EidoverseMcpLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export class EidoverseMcpUnavailableError extends Error {
  override readonly name = "EidoverseMcpUnavailableError";
}

export class EidoverseMcpRequestError extends Error {
  override readonly name = "EidoverseMcpRequestError";
}

export class EidoverseMcpClient {
  private session: EidoverseMcpSession | null = null;
  private openingSession: EidoverseMcpSession | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectDelay: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  private stopped = true;
  private remainingReconnectAttempts: number;
  private sensitiveValues: readonly string[] = [];
  private readonly logger: EidoverseMcpLogger;

  constructor(
    private readonly config: EidoverseMcpConfig,
    private readonly resolveCredential: EidoverseCredentialResolver,
    options: EidoverseMcpClientOptions = {},
  ) {
    this.remainingReconnectAttempts = config.reconnectMaxAttempts;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  start(): Promise<void> {
    if (this.session) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = this.connectInitial().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.cancelReconnectDelay();
    const active = this.session;
    const opening = this.openingSession;
    this.session = null;
    this.openingSession = null;
    await Promise.allSettled([
      active?.close(),
      opening && opening !== active ? opening.close() : undefined,
    ]);
    await this.reconnectPromise;
  }

  async look(): Promise<string> {
    return this.requestText({ name: "look", arguments: {} });
  }

  async say(text: string): Promise<void> {
    if (text.length > EIDOVERSE_SAY_MAX_TEXT_LENGTH || this.containsSensitiveValue(text)) {
      throw new EidoverseMcpRequestError("Eidoverse MCP say request failed");
    }
    const result = await this.requestText({ name: "say", arguments: { text } });
    if (result !== "said") {
      throw new EidoverseMcpRequestError("Eidoverse MCP say request failed");
    }
  }

  async pendingPings(): Promise<readonly string[]> {
    const result = await this.requestText({ name: "pending_pings", arguments: {} });
    if (result === "no pending pings") return [];
    return result.split("\n").filter((value) => value.length > 0);
  }

  private async connectInitial(): Promise<void> {
    try {
      await this.openSession();
      this.remainingReconnectAttempts = this.config.reconnectMaxAttempts;
      this.logger.info("Eidoverse MCP connected");
    } catch {
      this.stopped = true;
      throw new EidoverseMcpUnavailableError("Eidoverse MCP connection failed");
    }
  }

  private async openSession(): Promise<void> {
    let credential: string;
    try {
      credential = await this.resolveCredential(this.config.tokenRef);
    } catch {
      throw new EidoverseMcpUnavailableError("Eidoverse MCP credential is unavailable");
    }
    if (!credential) {
      throw new EidoverseMcpUnavailableError("Eidoverse MCP credential is unavailable");
    }
    this.sensitiveValues = uniqueNonEmpty([
      credential,
      this.config.tokenRef,
      this.config.worldUrl,
    ]);

    let nextSession: EidoverseMcpSession;
    nextSession = createStdioSession(
      this.config,
      credential,
      () => this.handleDisconnect(nextSession),
    );
    this.openingSession = nextSession;
    try {
      await nextSession.connect();
    } catch {
      await Promise.allSettled([nextSession.close()]);
      throw new EidoverseMcpUnavailableError("Eidoverse MCP connection failed");
    } finally {
      if (this.openingSession === nextSession) this.openingSession = null;
    }
    if (this.stopped) {
      await Promise.allSettled([nextSession.close()]);
      throw new EidoverseMcpUnavailableError("Eidoverse MCP connection stopped");
    }
    this.session = nextSession;
  }

  private handleDisconnect(disconnected: EidoverseMcpSession): void {
    if (this.session !== disconnected) return;
    this.session = null;
    if (this.stopped) return;
    this.logger.warn("Eidoverse MCP disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectPromise || this.stopped) return;
    if (this.remainingReconnectAttempts <= 0) {
      this.logger.warn("Eidoverse MCP reconnect budget exhausted");
      return;
    }
    this.reconnectPromise = this.reconnect().finally(() => {
      this.reconnectPromise = null;
      if (!this.stopped && !this.session && this.remainingReconnectAttempts <= 0) {
        this.logger.warn("Eidoverse MCP reconnect budget exhausted");
      }
    });
  }

  private async reconnect(): Promise<void> {
    while (!this.stopped && !this.session && this.remainingReconnectAttempts > 0) {
      const attempt = this.config.reconnectMaxAttempts - this.remainingReconnectAttempts;
      this.remainingReconnectAttempts -= 1;
      const delayMs = Math.min(
        this.config.reconnectBaseMs * (2 ** attempt),
        this.config.reconnectMaxMs,
      );
      await this.waitForReconnect(delayMs);
      if (this.stopped) return;
      try {
        await this.openSession();
        this.logger.info("Eidoverse MCP reconnected");
        return;
      } catch {
        // The next bounded attempt is the only recovery path.
      }
    }
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.reconnectDelay?.timer === timer) this.reconnectDelay = null;
        resolve();
      }, delayMs);
      this.reconnectDelay = { timer, resolve };
    });
  }

  private cancelReconnectDelay(): void {
    const pending = this.reconnectDelay;
    if (!pending) return;
    this.reconnectDelay = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private async requestText(request: EidoverseToolRequest): Promise<string> {
    const session = this.session;
    if (!session) {
      throw new EidoverseMcpUnavailableError("Eidoverse MCP is not connected");
    }
    try {
      const result = await session.request(request);
      const text = extractSingleText(result);
      if (this.containsSensitiveValue(text)) throw new Error("sensitive result");
      this.remainingReconnectAttempts = this.config.reconnectMaxAttempts;
      return text;
    } catch {
      throw new EidoverseMcpRequestError(`Eidoverse MCP ${request.name} request failed`);
    }
  }

  private containsSensitiveValue(value: string): boolean {
    return this.sensitiveValues.some((sensitive) => value.includes(sensitive));
  }
}

export function loadEidoverseMcpConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EidoverseMcpConfig | null {
  const enabled = optionalEnv(env, "EIDOVERSE_MCP_ENABLED");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new Error("EIDOVERSE_MCP_ENABLED must be 'true' or 'false'");
  }
  if (enabled !== "true") return null;

  const command = requiredEnv(env, "EIDOVERSE_MCP_COMMAND");
  const args = parseArgs(optionalEnv(env, "EIDOVERSE_MCP_ARGS_JSON") ?? "[]");
  const worldUrl = parseWorldUrl(requiredEnv(env, "EIDOVERSE_MCP_WORLD_URL"));
  const tokenRef = requiredEnv(env, "EIDOVERSE_MCP_TOKEN_REF");
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenRef)) {
    throw new Error("EIDOVERSE_MCP_TOKEN_REF must name an environment credential");
  }
  const worldName = requiredEnv(env, "EIDOVERSE_MCP_WORLD_NAME");
  const agentName = requiredEnv(env, "EIDOVERSE_MCP_AGENT_NAME");
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
  const reconnectMaxAttempts = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS",
    DEFAULT_RECONNECT_MAX_ATTEMPTS,
  );
  const requestTimeoutMs = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const pendingPingsPollIntervalMs = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_PENDING_PINGS_POLL_INTERVAL_MS",
    DEFAULT_PENDING_PINGS_POLL_INTERVAL_MS,
  );
  const ambientSayDebounceMs = positiveIntegerEnv(
    env,
    "EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS",
    DEFAULT_AMBIENT_SAY_DEBOUNCE_MS,
  );

  return {
    command,
    args,
    worldUrl,
    tokenRef,
    worldName,
    agentName,
    reconnectBaseMs,
    reconnectMaxMs,
    reconnectMaxAttempts,
    requestTimeoutMs,
    pendingPingsPollIntervalMs,
    ambientSayDebounceMs,
  };
}

export async function resolveEidoverseCredentialFromEnv(
  reference: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const value = env[reference];
  if (!value) {
    throw new EidoverseMcpUnavailableError(
      "Eidoverse MCP credential reference could not be resolved",
    );
  }
  return value;
}

function createStdioSession(
  config: EidoverseMcpConfig,
  joinToken: string,
  onDisconnect: () => void,
): EidoverseMcpSession {
  const client = new Client({ name: "psfn-satellite-hub", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: {
      ...getDefaultEnvironment(),
      WORLD_URL: config.worldUrl,
      JOIN_TOKEN: joinToken,
      WORLD_NAME: config.worldName,
      AGENT_NAME: config.agentName,
    },
    stderr: "ignore",
  });
  client.onclose = onDisconnect;
  client.onerror = () => undefined;
  return {
    connect: async () => {
      await client.connect(transport, {
        timeout: config.requestTimeoutMs,
        maxTotalTimeout: config.requestTimeoutMs,
      });
    },
    request: (request) => client.callTool(
      { name: request.name, arguments: request.arguments },
      { timeout: config.requestTimeoutMs, maxTotalTimeout: config.requestTimeoutMs },
    ),
    close: () => client.close(),
  };
}

function extractSingleText(result: CallToolResult): string {
  if (result.isError || result.content.length !== 1) {
    throw new Error("invalid MCP tool result");
  }
  const content = result.content[0];
  if (!content || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("invalid MCP tool result");
  }
  return content.text;
}

function parseArgs(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("EIDOVERSE_MCP_ARGS_JSON must be a JSON string array");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("EIDOVERSE_MCP_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function parseWorldUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EIDOVERSE_MCP_WORLD_URL must be a valid ws or wss URL");
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
    throw new Error("EIDOVERSE_MCP_WORLD_URL must be a credential-free ws or wss URL");
  }
  return url.toString();
}

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
