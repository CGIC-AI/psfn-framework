import { createHash } from 'node:crypto';
import type {
  McpServerConfig,
  McpServersConfig,
  McpToolPolicyEntry,
} from '../../../system/config/mcp-servers-config.js';
import {
  HIGH_INTIMACY_SENSITIVITY_LEVELS,
  TRUST_CEILING,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  McpProtocolClientFactory,
  McpProtocolClientPort,
  McpProtocolTool,
} from './protocol-client.js';

export type {
  McpProtocolClientFactory,
  McpProtocolClientPort,
} from './protocol-client.js';

export type McpBrokerErrorCode =
  | 'SERVER_NOT_FOUND'
  | 'SERVER_DISABLED'
  | 'COMPANION_NOT_ALLOWED'
  | 'TOOL_DENIED'
  | 'SENSITIVITY_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'STATIC_METADATA_WITHHELD'
  | 'STATIC_METADATA_INVALID'
  | 'STATIC_METADATA_TOO_LARGE'
  | 'TOOL_CATALOG_TOO_LARGE'
  | 'INVOCATION_ARGUMENTS_TOO_LARGE'
  | 'DYNAMIC_OUTPUT_TOO_LARGE'
  | 'DYNAMIC_OUTPUT_WITHHELD'
  | 'BROKER_CLOSED';

export class McpBrokerError extends Error {
  readonly name = 'McpBrokerError';

  constructor(
    readonly code: McpBrokerErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface McpScreeningResult {
  /** CogSec-safe text. Raw inbound content must never be substituted downstream. */
  effectiveText: string;
  withheld: boolean;
}

export interface McpCogSecScreeningPort {
  screenStaticMetadata(input: {
    companionId: string;
    serverId: string;
    sha256: string;
    text: string;
  }): Promise<McpScreeningResult>;
  screenDynamicOutput(input: {
    companionId: string;
    serverId: string;
    toolName: string;
    text: string;
  }): Promise<McpScreeningResult>;
}

export interface McpServerCatalogEntry {
  serverId: string;
  displayName: string;
  description: string;
  trustLevel: McpServerConfig['trust']['level'];
}

export interface McpToolSummary {
  serverId: string;
  serverDisplayName: string;
  toolName: string;
  description: string;
  effect: McpToolPolicyEntry['effect'];
  confirmation: McpToolPolicyEntry['confirmation'];
}

export interface McpInspectedTool {
  serverId: string;
  serverDisplayName: string;
  tool: McpProtocolTool;
  policy: McpToolPolicyEntry;
}

export interface McpScreenedToolResult {
  serverId: string;
  toolName: string;
  isError: boolean;
  effectiveText: string;
  withheld: boolean;
}

interface McpSessionState {
  key: string;
  companionId: string;
  server: McpServerConfig;
  client: McpProtocolClientPort;
  tools?: McpProtocolTool[];
  toolsExpiresAt?: number;
  listPromise?: Promise<McpProtocolTool[]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsedAt: number;
  closing?: Promise<void>;
}

interface StaticScreenCacheEntry {
  tools: McpProtocolTool[];
  lastUsedAt: number;
}

export interface McpGatewayBroker {
  getCatalog(input: { companionId: string }): McpServerCatalogEntry[];
  searchTools(input: {
    companionId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<McpToolSummary[]>;
  inspectTool(input: {
    companionId: string;
    serverId: string;
    toolName: string;
    signal?: AbortSignal;
  }): Promise<McpInspectedTool>;
  invokeTool(input: {
    companionId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    outboundSensitivity: SensitivityLevel;
    confirmed?: boolean;
    signal?: AbortSignal;
  }): Promise<McpScreenedToolResult>;
  releaseServer(input: { companionId: string; serverId: string }): Promise<void>;
  releaseCompanion(companionId: string): Promise<void>;
  health(): {
    activeSessions: number;
    cachedStaticMetadataEntries: number;
    sessions: Array<{ companionId: string; serverId: string; hasLoadedTools: boolean }>;
  };
  close(): Promise<void>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'null';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isTool(value: unknown): value is McpProtocolTool {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && isRecord(value.inputSchema);
}

function parseScreenedTools(text: string): McpProtocolTool[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpBrokerError(
      'STATIC_METADATA_INVALID',
      'CogSec returned invalid screened MCP metadata',
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools) || !parsed.tools.every(isTool)) {
    throw new McpBrokerError(
      'STATIC_METADATA_INVALID',
      'CogSec returned malformed screened MCP tool definitions',
    );
  }
  return parsed.tools;
}

function sessionKey(companionId: string, serverId: string): string {
  return JSON.stringify([companionId, serverId]);
}

function requiresConfirmation(
  policy: McpToolPolicyEntry,
  sensitivity: SensitivityLevel,
): boolean {
  if (policy.confirmation === 'always') return true;
  return policy.confirmation === 'sensitive'
    && HIGH_INTIMACY_SENSITIVITY_LEVELS.includes(
      sensitivity as (typeof HIGH_INTIMACY_SENSITIVITY_LEVELS)[number],
    );
}

function configuredToolPolicy(
  server: McpServerConfig,
  toolName: string,
): McpToolPolicyEntry | undefined {
  return (server.toolPolicy.tools as Partial<Record<string, McpToolPolicyEntry>>)[toolName];
}

function allowsCompanion(server: McpServerConfig, companionId: string): boolean {
  return server.allowedCompanionIds.some(allowedCompanionId => allowedCompanionId === companionId);
}

export function createMcpGatewayBroker(options: {
  config: McpServersConfig;
  clientFactory: McpProtocolClientFactory;
  screening: McpCogSecScreeningPort;
  now?: () => number;
}): McpGatewayBroker {
  const now = options.now ?? Date.now;
  const serversById = new Map(options.config.servers.map(server => [server.id, server]));
  const sessions = new Map<string, Promise<McpSessionState>>();
  const readySessions = new Map<string, McpSessionState>();
  const staticScreenCache = new Map<string, StaticScreenCacheEntry>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new McpBrokerError('BROKER_CLOSED', 'MCP broker is closed');
  }

  function serverFor(companionId: string, serverId: string): McpServerConfig {
    assertOpen();
    const server = serversById.get(serverId);
    if (!server) throw new McpBrokerError('SERVER_NOT_FOUND', `Unknown MCP server '${serverId}'`);
    if (!server.enabled) throw new McpBrokerError('SERVER_DISABLED', `MCP server '${serverId}' is disabled`);
    if (!allowsCompanion(server, companionId)) {
      throw new McpBrokerError(
        'COMPANION_NOT_ALLOWED',
        `Companion is not allowed to use MCP server '${serverId}'`,
      );
    }
    return server;
  }

  function touch(state: McpSessionState): void {
    state.lastUsedAt = now();
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      void closeSession(state.key);
    }, options.config.limits.idleConnectionTtlMs);
    state.idleTimer.unref();
  }

  async function closeState(state: McpSessionState): Promise<void> {
    if (state.closing) return state.closing;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.tools = undefined;
    state.toolsExpiresAt = undefined;
    state.listPromise = undefined;
    readySessions.delete(state.key);
    state.closing = state.client.close();
    await state.closing;
  }

  async function closeSession(key: string): Promise<void> {
    const pending = sessions.get(key);
    if (!pending) return;
    sessions.delete(key);
    await closeState(await pending);
  }

  async function getSession(companionId: string, server: McpServerConfig): Promise<McpSessionState> {
    const key = sessionKey(companionId, server.id);
    const existing = sessions.get(key);
    if (existing) {
      const state = await existing;
      touch(state);
      return state;
    }

    let state: McpSessionState | undefined;
    const created = options.clientFactory.create({
      companionId,
      server,
      connectTimeoutMs: options.config.limits.connectTimeoutMs,
      requestTimeoutMs: options.config.limits.requestTimeoutMs,
      maxPaginationPages: options.config.limits.maxPaginationPages,
      maxDynamicOutputBytes: options.config.limits.maxDynamicOutputBytes,
      onToolsChanged: () => {
        if (!state) return;
        state.tools = undefined;
        state.toolsExpiresAt = undefined;
      },
    }).then((client) => {
      state = {
        key,
        companionId,
        server,
        client,
        lastUsedAt: now(),
      };
      readySessions.set(key, state);
      touch(state);
      return state;
    }).catch((error: unknown) => {
      sessions.delete(key);
      throw error;
    });
    sessions.set(key, created);
    return created;
  }

  function cacheStaticScreen(hash: string, tools: McpProtocolTool[]): void {
    staticScreenCache.delete(hash);
    staticScreenCache.set(hash, { tools, lastUsedAt: now() });
    while (staticScreenCache.size > options.config.limits.maxCatalogToolsPerServer) {
      const oldest = staticScreenCache.keys().next().value as string | undefined;
      if (!oldest) break;
      staticScreenCache.delete(oldest);
    }
  }

  async function screenTools(
    companionId: string,
    server: McpServerConfig,
    rawTools: McpProtocolTool[],
  ): Promise<McpProtocolTool[]> {
    if (rawTools.length > options.config.limits.maxCatalogToolsPerServer) {
      throw new McpBrokerError(
        'TOOL_CATALOG_TOO_LARGE',
        `MCP server '${server.id}' exceeded its configured tool catalog limit`,
      );
    }
    const text = canonicalJson({ tools: rawTools });
    if (utf8Bytes(text) > options.config.limits.maxStaticMetadataBytes) {
      throw new McpBrokerError(
        'STATIC_METADATA_TOO_LARGE',
        `MCP server '${server.id}' exceeded its configured static metadata byte limit`,
      );
    }
    const hash = sha256(text);
    const cacheKey = JSON.stringify([companionId, hash]);
    const cached = staticScreenCache.get(cacheKey);
    if (cached) {
      cached.lastUsedAt = now();
      staticScreenCache.delete(cacheKey);
      staticScreenCache.set(cacheKey, cached);
      return cached.tools;
    }
    const result = await options.screening.screenStaticMetadata({
      companionId,
      serverId: server.id,
      sha256: hash,
      text,
    });
    if (result.withheld) {
      throw new McpBrokerError(
        'STATIC_METADATA_WITHHELD',
        `CogSec withheld tool metadata from MCP server '${server.id}'`,
      );
    }
    const tools = parseScreenedTools(result.effectiveText);
    cacheStaticScreen(cacheKey, tools);
    return tools;
  }

  async function loadTools(
    companionId: string,
    server: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpProtocolTool[]> {
    const state = await getSession(companionId, server);
    if (state.tools && (state.toolsExpiresAt ?? 0) > now()) return state.tools;
    if (state.listPromise) return state.listPromise;

    const refresh = state.client.listTools({
      ...(signal ? { signal } : {}),
      timeoutMs: options.config.limits.requestTimeoutMs,
    }).then(async ({ tools }) => {
      const screened = await screenTools(companionId, server, tools);
      state.tools = screened;
      state.toolsExpiresAt = now() + options.config.limits.metadataCacheTtlMs;
      return screened;
    }).finally(() => {
      state.listPromise = undefined;
      touch(state);
    });
    state.listPromise = refresh;
    return refresh;
  }

  async function inspectedTool(input: {
    companionId: string;
    serverId: string;
    toolName: string;
    signal?: AbortSignal;
  }): Promise<McpInspectedTool> {
    const server = serverFor(input.companionId, input.serverId);
    const policy = configuredToolPolicy(server, input.toolName);
    if (!policy) {
      throw new McpBrokerError(
        'TOOL_DENIED',
        `Tool '${input.toolName}' is not allowlisted for MCP server '${input.serverId}'`,
      );
    }
    const tools = await loadTools(input.companionId, server, input.signal);
    const tool = tools.find(candidate => candidate.name === input.toolName);
    if (!tool) {
      throw new McpBrokerError(
        'TOOL_DENIED',
        `Tool '${input.toolName}' is not available from MCP server '${input.serverId}'`,
      );
    }
    return {
      serverId: server.id,
      serverDisplayName: server.displayName,
      tool,
      policy,
    };
  }

  return {
    getCatalog(input) {
      assertOpen();
      return options.config.servers
        .filter(server => server.enabled && allowsCompanion(server, input.companionId))
        .map(server => ({
          serverId: server.id,
          displayName: server.displayName,
          description: server.description,
          trustLevel: server.trust.level,
        }));
    },

    async searchTools(input) {
      assertOpen();
      const query = input.query.trim().toLowerCase();
      const limit = Math.max(1, Math.min(
        input.limit ?? options.config.limits.maxCatalogToolsPerServer,
        options.config.limits.maxCatalogToolsPerServer,
      ));
      const matches: McpToolSummary[] = [];
      for (const server of options.config.servers) {
        if (!server.enabled || !allowsCompanion(server, input.companionId)) continue;
        const tools = await loadTools(input.companionId, server, input.signal);
        for (const tool of tools) {
          const policy = configuredToolPolicy(server, tool.name);
          if (!policy) continue;
          const haystack = `${server.displayName}\n${server.description}\n${tool.name}\n${tool.description ?? ''}`
            .toLowerCase();
          if (query && !haystack.includes(query)) continue;
          matches.push({
            serverId: server.id,
            serverDisplayName: server.displayName,
            toolName: tool.name,
            description: tool.description ?? '',
            effect: policy.effect,
            confirmation: policy.confirmation,
          });
          if (matches.length >= limit) return matches;
        }
      }
      return matches;
    },

    inspectTool: inspectedTool,

    async invokeTool(input) {
      const inspected = await inspectedTool(input);
      const server = serverFor(input.companionId, input.serverId);
      if (utf8Bytes(canonicalJson(input.arguments)) > options.config.limits.maxDynamicOutputBytes) {
        throw new McpBrokerError(
          'INVOCATION_ARGUMENTS_TOO_LARGE',
          `MCP tool '${input.toolName}' arguments exceeded the configured byte limit`,
        );
      }
      const allowedSensitivity = server.trust.allowedOutboundSensitivity
        ?? TRUST_CEILING[server.trust.level];
      if (!allowedSensitivity.includes(input.outboundSensitivity)) {
        throw new McpBrokerError(
          'SENSITIVITY_DENIED',
          `MCP server '${server.id}' is not permitted to receive ${input.outboundSensitivity} content`,
        );
      }
      if (requiresConfirmation(inspected.policy, input.outboundSensitivity) && input.confirmed !== true) {
        throw new McpBrokerError(
          'CONFIRMATION_REQUIRED',
          `MCP tool '${input.toolName}' requires operator confirmation for this invocation`,
        );
      }

      const state = await getSession(input.companionId, server);
      const rawResult = await state.client.callTool({
        name: input.toolName,
        arguments: input.arguments,
        toolDefinition: inspected.tool,
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: options.config.limits.requestTimeoutMs,
      });
      touch(state);
      const rawText = canonicalJson(rawResult);
      if (utf8Bytes(rawText) > options.config.limits.maxDynamicOutputBytes) {
        throw new McpBrokerError(
          'DYNAMIC_OUTPUT_TOO_LARGE',
          `MCP tool '${input.toolName}' exceeded its configured output byte limit`,
        );
      }
      const screened = await options.screening.screenDynamicOutput({
        companionId: input.companionId,
        serverId: server.id,
        toolName: input.toolName,
        text: rawText,
      });
      if (utf8Bytes(screened.effectiveText) > options.config.limits.maxDynamicOutputBytes) {
        throw new McpBrokerError(
          'DYNAMIC_OUTPUT_TOO_LARGE',
          `CogSec output for MCP tool '${input.toolName}' exceeded its configured byte limit`,
        );
      }
      return {
        serverId: server.id,
        toolName: input.toolName,
        isError: isRecord(rawResult) && rawResult.isError === true,
        effectiveText: screened.effectiveText,
        withheld: screened.withheld,
      };
    },

    async releaseServer(input) {
      await closeSession(sessionKey(input.companionId, input.serverId));
    },

    async releaseCompanion(companionId) {
      const keys: string[] = [];
      for (const [key, pending] of sessions) {
        const state = await pending;
        if (state.companionId === companionId) keys.push(key);
      }
      await Promise.all(keys.map(closeSession));
    },

    health() {
      const snapshot = [...readySessions.values()].map(state => ({
        companionId: state.companionId,
        serverId: state.server.id,
        hasLoadedTools: state.tools !== undefined,
      }));
      return {
        activeSessions: sessions.size,
        cachedStaticMetadataEntries: staticScreenCache.size,
        sessions: snapshot,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...sessions.values()];
      sessions.clear();
      readySessions.clear();
      await Promise.all(pending.map(async state => closeState(await state)));
      staticScreenCache.clear();
    },
  };
}
