// ── Obsidian Vault Operations ──
// Core operations for reading/writing notes in an Obsidian vault via the CLI.
// All operations use the Obsidian CLI which communicates with the running desktop app via IPC.

import { execSync } from 'node:child_process';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';

const OBSIDIAN_SERVICES = [
  'obsidian-xvfb',
  'obsidian-openbox',
  'obsidian-vnc',
  'obsidian-headless',
];
const OBSIDIAN_RESTART_WAIT_MS = 10_000;

const log = createComponentLogger('VaultOps');

export interface VaultWriteResult {
  name: string;
  folder?: string;
  mode: 'create' | 'append' | 'prepend';
}

export interface VaultReadResult {
  name: string;
  content: string;
}

export interface VaultSearchResult {
  query: string;
  results: Array<{ path: string; snippet?: string }>;
}

export interface VaultDailyResult {
  date: string;
  content?: string;
  mode: 'read' | 'append';
}

export interface VaultOperations {
  write(
    name: string,
    content: string,
    opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' },
  ): Promise<VaultWriteResult>;
  read(nameOrPath: string): Promise<VaultReadResult>;
  search(query: string, limit?: number): Promise<VaultSearchResult>;
  daily(opts?: { content?: string }): Promise<VaultDailyResult>;
}

export interface VaultOpsConfig {
  vaultName: string;
  cliPath: string;
  timeoutMs: number;
}

const DEFAULT_CONFIG: VaultOpsConfig = {
  vaultName: '',
  cliPath: 'obsidian',
  timeoutMs: 10_000,
};

export class VaultOps implements VaultOperations {
  private readonly config: VaultOpsConfig;

  constructor(config: Partial<VaultOpsConfig> & Pick<VaultOpsConfig, 'vaultName'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.vaultName) {
      throw new Error('VaultOps requires a vaultName');
    }
  }

  async write(
    name: string,
    content: string,
    opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' },
  ): Promise<VaultWriteResult> {
    const mode = opts?.mode ?? 'create';

    if (mode === 'create') {
      const args = [
        `vault=${this.shellEscape(this.config.vaultName)}`,
        'create',
        `name=${this.shellEscape(name)}`,
        `content=${this.shellEscape(content)}`,
      ];
      if (opts?.folder) {
        args.push(`path=${this.shellEscape(opts.folder)}`);
      }
      await this.exec(args);
    } else {
      // append or prepend
      const args = [
        `vault=${this.shellEscape(this.config.vaultName)}`,
        mode,
        `file=${this.shellEscape(name)}`,
        `content=${this.shellEscape(content)}`,
      ];
      await this.exec(args);
    }

    log.debug('Vault write completed', { name, mode, folder: opts?.folder });
    return { name, folder: opts?.folder, mode };
  }

  async read(nameOrPath: string): Promise<VaultReadResult> {
    const args = [
      `vault=${this.shellEscape(this.config.vaultName)}`,
      'read',
      `file=${this.shellEscape(nameOrPath)}`,
    ];
    const content = await this.exec(args);
    return { name: nameOrPath, content: content.trim() };
  }

  async search(query: string, limit?: number): Promise<VaultSearchResult> {
    const args = [
      `vault=${this.shellEscape(this.config.vaultName)}`,
      'search',
      `query=${this.shellEscape(query)}`,
      'format=json',
    ];
    if (limit !== undefined && limit > 0) {
      args.push(`limit=${limit}`);
    }
    const raw = await this.exec(args);
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
      // Non-JSON output — treat as line-delimited paths
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
        `vault=${this.shellEscape(this.config.vaultName)}`,
        'daily:append',
        `content=${this.shellEscape(opts.content)}`,
      ];
      await this.exec(args);
      return { date: today, mode: 'append' };
    }

    const args = [
      `vault=${this.shellEscape(this.config.vaultName)}`,
      'daily:read',
    ];
    const content = await this.exec(args);
    return { date: today, content: content.trim(), mode: 'read' };
  }

  // ── Private helpers ──

  private async exec(args: string[], isRetry = false): Promise<string> {
    const cmd = `${this.config.cliPath} ${args.join(' ')}`;
    try {
      return execSync(cmd, {
        timeout: this.config.timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const record = err as Record<string, unknown>;
      const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
      const code = typeof record.status === 'number' ? record.status : null;
      const msg = stderr || toErrorMessage(err);

      // Map common errors to user-friendly messages
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(`obsidian command not found — ensure CLI is installed and on PATH`);
      }
      if (msg.includes('vault') && msg.includes('not found')) {
        throw new Error(`Vault '${this.config.vaultName}' not found — check the canonical Obsidian settings in settings.json`);
      }
      if (msg.includes('IPC') || msg.includes('connect')) {
        if (!isRetry) {
          log.warn('Obsidian IPC not available — restarting services and retrying');
          await this.restartObsidianServices();
          return this.exec(args, true);
        }
        throw new Error('Obsidian desktop app is not running (services restarted but IPC still unavailable)');
      }
      if (msg.includes('CLI') && msg.includes('not enabled')) {
        throw new Error('Obsidian CLI not enabled — toggle in Settings → General');
      }

      throw new Error(`Obsidian CLI failed (exit ${code}): ${msg}`);
    }
  }

  private async restartObsidianServices(): Promise<void> {
    try {
      execSync(`systemctl --user restart ${OBSIDIAN_SERVICES.join(' ')}`, {
        timeout: 15_000,
        stdio: 'pipe',
      });
      log.info('Obsidian services restarted — waiting for startup', {
        services: OBSIDIAN_SERVICES,
        waitMs: OBSIDIAN_RESTART_WAIT_MS,
      });
    } catch (err) {
      log.warn('Failed to restart Obsidian services', { error: toErrorMessage(err) });
    }
    await new Promise(resolve => setTimeout(resolve, OBSIDIAN_RESTART_WAIT_MS));
  }

  private shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
}
