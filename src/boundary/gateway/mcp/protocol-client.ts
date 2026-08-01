import type { Tool } from '@modelcontextprotocol/client';
import type { McpServerConfig } from '../../../system/config/mcp-servers-config.js';

export interface McpProtocolClientPort {
  listTools(input: { signal?: AbortSignal; timeoutMs: number }): Promise<{ tools: Tool[] }>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    toolDefinition: Tool;
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
