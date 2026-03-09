// ── Gateway-backed Vault Operations ──
// Agent-side adapter that routes vault operations through dedicated gateway
// vault RPC methods. Used in gateway/agent split mode where the agent
// container has no direct access to the Obsidian CLI.

import type { GatewayClient } from '../gateway/client.js';
import type {
  VaultOperations,
  VaultWriteResult,
  VaultReadResult,
  VaultSearchResult,
  VaultDailyResult,
  VaultOpsConfig,
} from './ops.js';

export class GatewayVaultOps implements VaultOperations {
  private readonly gateway: GatewayClient;

  constructor(
    gateway: GatewayClient,
    _config: Pick<VaultOpsConfig, 'vaultName'> & Partial<VaultOpsConfig>,
  ) {
    this.gateway = gateway;
  }

  async write(
    name: string,
    content: string,
    opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' },
  ): Promise<VaultWriteResult> {
    return await this.gateway.vaultWrite(name, content, opts);
  }

  async read(nameOrPath: string): Promise<VaultReadResult> {
    return await this.gateway.vaultRead(nameOrPath);
  }

  async search(query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.gateway.vaultSearch(query, limit);
  }

  async daily(opts?: { content?: string }): Promise<VaultDailyResult> {
    return await this.gateway.vaultDaily(opts?.content);
  }
}
