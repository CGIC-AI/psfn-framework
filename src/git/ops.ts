// ── Git Operations Service ──
// Core git operations for self-modification tools.
// All write operations audit-logged, path-validated, and branch-protected.

import { execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, normalize, dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('GitOps');

export interface GitOpsConfig {
  repoRoot: string;
  allowedPaths: string[];
  protectedBranches: string[];
  auditLogPath: string;
  execTimeoutMs: number;
}

const DEFAULT_CONFIG: GitOpsConfig = {
  repoRoot: process.cwd(),
  allowedPaths: ['src/', 'docs/', 'purrsephone/'],
  protectedBranches: ['main', 'master'],
  auditLogPath: 'data/repo-audit.jsonl',
  execTimeoutMs: 30_000,
};

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitDiffResult {
  staged: string;
  unstaged: string;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

interface AuditEntry {
  timestamp: string;
  operation: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
}

export class GitOps {
  private config: GitOpsConfig;

  constructor(config?: Partial<GitOpsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Read-only operations ──

  status(): GitStatusResult {
    const raw = this.exec('git status --porcelain=v2 --branch');
    const lines = raw.split('\n').filter(Boolean);

    let branch = '';
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      if (line.startsWith('# branch.head ')) {
        branch = line.slice('# branch.head '.length);
      } else if (line.startsWith('# branch.ab ')) {
        const match = line.match(/\+(\d+) -(\d+)/);
        if (match) {
          ahead = parseInt(match[1], 10);
          behind = parseInt(match[2], 10);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Ordinary changed entry (1) or rename/copy (2)
        // Format: 1 XY sub mH mI mW hH hI path
        // Format: 2 XY sub mH mI mW hH hI X??? origPath\tpath
        const parts = line.split('\t');
        const statusField = line.split(' ');
        const xy = statusField[1] ?? '';
        const filePath = parts.length > 1
          ? parts[parts.length - 1]
          : statusField[statusField.length - 1] ?? '';
        if (xy[0] !== '.') staged.push(filePath);
        if (xy[1] !== '.') modified.push(filePath);
      } else if (line.startsWith('? ')) {
        untracked.push(line.slice(2));
      }
    }

    return { branch, ahead, behind, staged, modified, untracked };
  }

  diff(opts?: { staged?: boolean }): GitDiffResult {
    const staged = opts?.staged !== false ? this.exec('git diff --cached') : '';
    const unstaged = this.exec('git diff');
    return { staged, unstaged };
  }

  currentBranch(): string {
    return this.exec('git rev-parse --abbrev-ref HEAD').trim();
  }

  isProtectedBranch(branch?: string): boolean {
    const current = branch ?? this.currentBranch();
    return this.config.protectedBranches.includes(current);
  }

  // ── Write operations ──

  createBranch(name: string, startPoint?: string): string {
    // Validate branch name -- only allow safe characters
    if (!/^[a-zA-Z0-9._\/-]+$/.test(name)) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    if (this.config.protectedBranches.includes(name)) {
      throw new Error(`Cannot create branch with protected name: ${name}`);
    }

    const cmd = startPoint
      ? `git checkout -b ${this.shellEscape(name)} ${this.shellEscape(startPoint)}`
      : `git checkout -b ${this.shellEscape(name)}`;
    this.exec(cmd);
    this.appendAudit({
      timestamp: new Date().toISOString(),
      operation: 'createBranch',
      args: { name, startPoint },
    });
    return name;
  }

  applyPatch(filePath: string, content: string): void {
    this.validatePath(filePath);
    this.assertNotProtected();

    const fullPath = resolve(this.config.repoRoot, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    this.exec(`git add ${this.shellEscape(filePath)}`);
    this.appendAudit({
      timestamp: new Date().toISOString(),
      operation: 'applyPatch',
      args: { filePath, contentLength: content.length },
    });
  }

  commit(message: string, intent: string, scope?: string): GitCommitResult {
    this.assertNotProtected();

    const fullMessage = [
      message,
      '',
      `[Intent] ${intent}`,
      scope ? `[Scope] ${scope}` : null,
      '[Agent] Purrsephone',
      '[Signed-off-by] purrsephone-agent',
    ].filter(Boolean).join('\n');

    this.exec(`git commit -m ${this.shellEscape(fullMessage)}`);

    const hash = this.exec('git rev-parse --short HEAD').trim();
    const stat = this.exec('git diff --stat HEAD~1..HEAD');
    const filesMatch = stat.match(/(\d+) file/);
    const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;

    this.appendAudit({
      timestamp: new Date().toISOString(),
      operation: 'commit',
      args: { message, intent, scope },
      result: hash,
    });

    return { hash, message, filesChanged };
  }

  openPR(title: string, body: string, base?: string): string {
    const baseArg = base ? `--base ${this.shellEscape(base)}` : '';
    try {
      const result = this.exec(
        `gh pr create --title ${this.shellEscape(title)} --body ${this.shellEscape(body)} ${baseArg}`,
      );
      const url = result.trim();
      this.appendAudit({
        timestamp: new Date().toISOString(),
        operation: 'openPR',
        args: { title, base },
        result: url,
      });
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendAudit({
        timestamp: new Date().toISOString(),
        operation: 'openPR',
        args: { title, base },
        error: msg,
      });
      throw new Error(`Failed to create PR: ${msg}`);
    }
  }

  // ── Policy ──

  validatePath(filePath: string): void {
    const normalized = normalize(filePath);

    // Block path traversal
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }

    const resolved = resolve(this.config.repoRoot, normalized);
    const rel = relative(this.config.repoRoot, resolved);

    // Must be inside repo
    if (rel.startsWith('..')) {
      throw new Error(`Path outside repository: ${filePath}`);
    }

    // Must be in allowed paths
    const inAllowed = this.config.allowedPaths.some(prefix =>
      rel.startsWith(prefix) || rel === prefix.replace(/\/$/, ''),
    );
    if (!inAllowed) {
      throw new Error(
        `Path not in allowed directories (${this.config.allowedPaths.join(', ')}): ${filePath}`,
      );
    }
  }

  assertNotProtected(branch?: string): void {
    if (this.isProtectedBranch(branch)) {
      throw new Error(
        `Operation blocked on protected branch: ${branch ?? this.currentBranch()}`,
      );
    }
  }

  // ── Private helpers ──

  private exec(cmd: string): string {
    try {
      return execSync(cmd, {
        cwd: this.config.repoRoot,
        timeout: this.config.execTimeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? (err as any).stderr || err.message : String(err);
      throw new Error(`Git command failed: ${msg}`);
    }
  }

  private shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  private appendAudit(entry: AuditEntry): void {
    try {
      const fullPath = resolve(this.config.repoRoot, this.config.auditLogPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      appendFileSync(fullPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      log.error('Failed to write audit log', { error: String(err) });
    }
  }
}
