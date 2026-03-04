// ── Gateway-backed Vault Operations ──
// Agent-side adapter that routes all vault operations through the host gateway
// shell.exec RPC surface. Used in gateway/agent split mode where the agent
// container has no access to the Obsidian binary.

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
  private readonly config: Pick<VaultOpsConfig, 'vaultName' | 'cliPath' | 'timeoutMs'>;

  constructor(
    gateway: GatewayClient,
    config: Pick<VaultOpsConfig, 'vaultName'> & Partial<VaultOpsConfig>,
  ) {
    this.gateway = gateway;
    this.config = {
      vaultName: config.vaultName,
      cliPath: config.cliPath ?? 'obsidian',
      timeoutMs: config.timeoutMs ?? 10_000,
    };
  }

  async write(
    name: string,
    content: string,
    opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' },
  ): Promise<VaultWriteResult> {
    const mode = opts?.mode ?? 'create';
    const args = this.buildWriteArgs(name, content, mode, opts?.folder);
    await this.shellExec(args);
    return { name, folder: opts?.folder, mode };
  }

  async read(nameOrPath: string): Promise<VaultReadResult> {
    const args = [
      `vault=${this.esc(this.config.vaultName)}`,
      'read',
      `file=${this.esc(nameOrPath)}`,
    ];
    const content = await this.shellExec(args);
    return { name: nameOrPath, content: content.trim() };
  }

  async search(query: string, limit?: number): Promise<VaultSearchResult> {
    const args = [
      `vault=${this.esc(this.config.vaultName)}`,
      'search',
      `query=${this.esc(query)}`,
      'format=json',
    ];
    if (limit !== undefined && limit > 0) {
      args.push(`limit=${limit}`);
    }
    const raw = await this.shellExec(args);
    let results: Array<{ path: string; snippet?: string }> = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        results = parsed.map((entry: unknown) => {
          if (typeof entry === 'object' && entry !== null) {
            const obj = entry as Record<string, unknown>;
            return {
              path: String(obj.path ?? obj.file ?? ''),
              snippet: typeof obj.snippet === 'string' ? obj.snippet : undefined,
            };
          }
          return { path: String(entry) };
        });
      }
    } catch {
      results = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(path => ({ path }));
    }
    return { query, results };
  }

  async daily(opts?: { content?: string }): Promise<VaultDailyResult> {
    const today = new Date().toISOString().slice(0, 10);

    if (opts?.content) {
      const args = [
        `vault=${this.esc(this.config.vaultName)}`,
        'daily:append',
        `content=${this.esc(opts.content)}`,
      ];
      await this.shellExec(args);
      return { date: today, mode: 'append' };
    }

    const args = [
      `vault=${this.esc(this.config.vaultName)}`,
      'daily:read',
    ];
    const content = await this.shellExec(args);
    return { date: today, content: content.trim(), mode: 'read' };
  }

  // ── Private helpers ──

  private buildWriteArgs(
    name: string,
    content: string,
    mode: 'create' | 'append' | 'prepend',
    folder?: string,
  ): string[] {
    if (mode === 'create') {
      const args = [
        `vault=${this.esc(this.config.vaultName)}`,
        'create',
        `name=${this.esc(name)}`,
        `content=${this.esc(content)}`,
      ];
      if (folder) args.push(`path=${this.esc(folder)}`);
      return args;
    }
    return [
      `vault=${this.esc(this.config.vaultName)}`,
      mode,
      `file=${this.esc(name)}`,
      `content=${this.esc(content)}`,
    ];
  }

  private async shellExec(args: string[]): Promise<string> {
    const result = await this.gateway.shellExec(
      this.config.cliPath,
      args,
      { timeoutMs: this.config.timeoutMs },
    );
    if (result.exitCode !== 0) {
      const msg = result.stderr.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Obsidian CLI failed: ${msg}`);
    }
    return result.stdout;
  }

  private esc(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
}
