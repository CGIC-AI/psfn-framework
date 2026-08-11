export type RuntimeServiceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'not_applicable';

export type RuntimeServiceId = 'gateway' | 'vault' | 'ntfy' | 'mcp' | 'approval_notifications';

export interface McpRuntimeServerHealth {
  serverId: string;
  displayName: string;
  trustLevel: TrustLevel;
  activeSession: boolean;
  hasLoadedTools: boolean;
  metadata: {
    disposition: 'not_scanned' | 'passed';
    sha256?: string;
    screenedAt?: number;
    toolCount?: number;
  };
  tools: Array<{
    toolName: string;
    effect: McpToolEffect;
    confirmation: McpConfirmationMode;
  }>;
}

export interface McpRuntimeHealthDetail {
  activeSessions: number;
  cachedStaticMetadataEntries: number;
  servers: McpRuntimeServerHealth[];
}

export interface RuntimeServiceFailure {
  message: string;
  at: number;
  scope?: string;
}

export interface RuntimeServiceHealth {
  serviceId: RuntimeServiceId;
  status: RuntimeServiceHealthStatus;
  detail: string;
  checkedAt: number;
  availableActions?: string[];
  lastFailure?: RuntimeServiceFailure;
  /** Content-free MCP policy and screening projection; never carries endpoint/auth/content. */
  mcp?: McpRuntimeHealthDetail;
}

export interface RuntimeServiceHealthSnapshot {
  checkedAt: number;
  services: RuntimeServiceHealth[];
}
import type {
  McpConfirmationMode,
  McpToolEffect,
} from '../../system/config/mcp-servers-config.js';
import type { TrustLevel } from '../../system/trust/types.js';
