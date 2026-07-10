// ── External Obsidian Vault Operations ──
// Core operations for bounded external Obsidian vault access via the CLI.
// All operations use the Obsidian CLI which communicates with the running desktop app via IPC.

import { execFileSync } from 'node:child_process';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { sleep } from '../../../shared/utils/timing.js';

const OBSIDIAN_SERVICES = [
  'obsidian-xvfb',
  'obsidian-openbox',
  'obsidian-vnc',
  'obsidian-headless',
];
const OBSIDIAN_RESTART_WAIT_MS = 10_000;

const log = createComponentLogger('VaultOps');

// Characters permitted in an Obsidian CLI executable path. Deliberately narrow:
// letters, digits, dot, underscore, hyphen, and forward slash only. Any shell
// metacharacter (`; & | $ \` ( ) < > ' " * ? space`, etc.) is rejected. The
// executable is spawned with `shell: false`, so this is defence-in-depth: it
// stops an admin-supplied cliPath from ever naming anything but a plain binary.
const CLI_PATH_ALLOWED = /^[A-Za-z0-9._/-]+$/;

/**
 * Validate the Obsidian CLI executable path before it is handed to
 * `execFileSync`. Rejects shell metacharacters and requires either a bare
 * command name (resolved via PATH) or an absolute path — never a relative path
 * or anything containing separators that could smuggle in shell syntax.
 *
 * `cliPath` originates from admin-mutable settings, so this is the fail-closed
 * gate that prevents command injection (bead lget).
 */
export function validateVaultCliPath(cliPath: string): string {
  if (typeof cliPath !== 'string' || cliPath.length === 0) {
    throw new Error('Obsidian CLI path is required and must be a non-empty string');
  }
  if (!CLI_PATH_ALLOWED.test(cliPath)) {
    throw new Error(
      `Refusing to use Obsidian CLI path '${cliPath}': it contains characters outside `
      + '[A-Za-z0-9._/-] (shell metacharacters and whitespace are not allowed)',
    );
  }
  const isBareName = !cliPath.includes('/');
  const isAbsolute = cliPath.startsWith('/');
  if (!isBareName && !isAbsolute) {
    throw new Error(
      `Refusing to use Obsidian CLI path '${cliPath}': it must be an absolute path or a bare command name`,
    );
  }
  return cliPath;
}

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
    // Fail closed at construction: a poisoned cliPath never reaches a spawn.
    validateVaultCliPath(this.config.cliPath);
  }

  async write(
    name: string,
    content: string,
    opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' },
  ): Promise<VaultWriteResult> {
    const mode = opts?.mode ?? 'create';

    if (mode === 'create') {
      const args = [
        `vault=${this.config.vaultName}`,
        'create',
        `name=${name}`,
        `content=${content}`,
      ];
      if (opts?.folder) {
        args.push(`path=${opts.folder}`);
      }
      await this.exec(args);
    } else {
      // append or prepend
      const args = [
        `vault=${this.config.vaultName}`,
        mode,
        `file=${name}`,
        `content=${content}`,
      ];
      await this.exec(args);
    }

    log.debug('Vault write completed', { name, mode, folder: opts?.folder });
    return { name, folder: opts?.folder, mode };
  }

  async read(nameOrPath: string): Promise<VaultReadResult> {
    const args = [
      `vault=${this.config.vaultName}`,
      'read',
      `file=${nameOrPath}`,
    ];
    const content = await this.exec(args);
    return { name: nameOrPath, content: content.trim() };
  }

  async search(query: string, limit?: number): Promise<VaultSearchResult> {
    const args = [
      `vault=${this.config.vaultName}`,
      'search',
      `query=${query}`,
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
        `vault=${this.config.vaultName}`,
        'daily:append',
        `content=${opts.content}`,
      ];
      await this.exec(args);
      return { date: today, mode: 'append' };
    }

    const args = [
      `vault=${this.config.vaultName}`,
      'daily:read',
    ];
    const content = await this.exec(args);
    return { date: today, content: content.trim(), mode: 'read' };
  }

  // ── Private helpers ──

  private async exec(args: string[], isRetry = false): Promise<string> {
    // shell: false — the executable and every argument are passed as a raw argv
    // array, so no shell parses cliPath or the args. Shell metacharacters in a
    // note title, date, or query are handed to the CLI as literal argv tokens,
    // never interpreted. cliPath was already validated at construction.
    try {
      return execFileSync(this.config.cliPath, args, {
        timeout: this.config.timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
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
        throw new Error(`External vault '${this.config.vaultName}' not found — check the Obsidian bridge settings in settings.json`);
      }
      if (msg.includes('IPC') || msg.includes('connect')) {
        if (!isRetry) {
          log.warn('Obsidian IPC not available — restarting services and retrying');
          const restarted = await this.restartObsidianServices();
          if (restarted) {
            return this.exec(args, true);
          }
        }
        throw new Error('Obsidian desktop app is not running (services restarted but IPC still unavailable)');
      }
      if (msg.includes('CLI') && msg.includes('not enabled')) {
        throw new Error('Obsidian CLI not enabled — toggle in Settings → General');
      }

      throw new Error(`Obsidian CLI failed (exit ${code}): ${msg}`);
    }
  }

  private async restartObsidianServices(): Promise<boolean> {
    try {
      // shell: false with a fixed argv — the service list is a hardcoded
      // constant, never user input.
      execFileSync('systemctl', ['--user', 'restart', ...OBSIDIAN_SERVICES], {
        timeout: 15_000,
        stdio: 'pipe',
        shell: false,
      });
      log.info('Obsidian services restarted — waiting for startup', {
        services: OBSIDIAN_SERVICES,
        waitMs: OBSIDIAN_RESTART_WAIT_MS,
      });
      await sleep(OBSIDIAN_RESTART_WAIT_MS);
      return true;
    } catch (err) {
      log.warn('Failed to restart Obsidian services', { error: toErrorMessage(err) });
      return false;
    }
  }
}
