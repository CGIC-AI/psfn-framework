import type { McpServerConfig } from '../../../system/config/mcp-servers-config.js';

/**
 * Stable gateway-owned subset of an MCP tool definition.
 *
 * Keeping the SDK's schema-inferred `Tool` type behind the adapter prevents its
 * implementation-heavy type graph from leaking through gateway declarations.
 * Runtime tool objects retain every server-provided field for hashing and calls.
 */
export interface McpProtocolTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpProtocolClientPort {
  listTools(input: { signal?: AbortSignal; timeoutMs: number }): Promise<{ tools: McpProtocolTool[] }>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    toolDefinition: McpProtocolTool;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpProtocolClientFactory {
  create(input: {
    companionId: string;
    server: McpServerConfig;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    maxPaginationPages: number;
    maxDynamicOutputBytes: number;
    onToolsChanged: () => void;
  }): Promise<McpProtocolClientPort>;
}
