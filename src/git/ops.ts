// ── Git Operations Service ──
// Core git operations for self-modification tools.
// All write operations audit-logged, path-validated, and branch-protected.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, relative, normalize, dirname } from 'node:path';
import {
  DEFAULT_COMPANION_ID,
  DEFAULT_COMPANION_NAME,
} from '../identity/companion-naming.js';
import { createComponentLogger } from '../logger.js';
import { REPO_ALLOWED_PATHS } from '../security/policy-constants.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('GitOps');

export interface GitAuditRotationConfig {
  maxSizeBytes: number;
  maxAgeMs: number;
  maxCount: number;
}

export interface GitOpsConfig {
  repoRoot: string;
  allowedPaths: string[];
  protectedBranches: string[];
  auditLogPath: string;
  auditRotation: GitAuditRotationConfig;
  execTimeoutMs: number;
}

const DEFAULT_AUDIT_ROTATION: GitAuditRotationConfig = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 50_000,
};

const DEFAULT_CONFIG: GitOpsConfig = {
  repoRoot: process.cwd(),
  allowedPaths: [...REPO_ALLOWED_PATHS],
  protectedBranches: ['main', 'master'],
  auditLogPath: 'data/repo-audit.jsonl',
  auditRotation: { ...DEFAULT_AUDIT_ROTATION },
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

export interface GitOperations {
  status(): GitStatusResult | Promise<GitStatusResult>;
  diff(opts?: { staged?: boolean }): GitDiffResult | Promise<GitDiffResult>;
  createBranch(name: string, startPoint?: string): string | Promise<string>;
  applyPatch(filePath: string, content: string): void | Promise<void>;
  commit(message: string, intent: string, scope?: string): GitCommitResult | Promise<GitCommitResult>;
  openPR(title: string, body: string, base?: string): string | Promise<string>;
}

interface AuditEntry {
  timestamp: string;
  operation: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
}

export class GitOps implements GitOperations {
  private readonly config: GitOpsConfig;

  constructor(config?: Partial<GitOpsConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      auditRotation: resolveAuditRotationConfig(config?.auditRotation),
    };
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
      `[Agent] ${DEFAULT_COMPANION_NAME}`,
      `[Signed-off-by] ${DEFAULT_COMPANION_ID}-agent`,
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
      const msg = toErrorMessage(err);
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
      const record = err as Record<string, unknown>;
      const stderr = typeof record.stderr === 'string' ? record.stderr : undefined;
      const msg = stderr || toErrorMessage(err);
      throw new Error(`Git command failed: ${msg}`);
    }
  }

  private shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  private appendAudit(entry: AuditEntry): void {
    try {
      const fullPath = resolve(this.config.repoRoot, this.config.auditLogPath);
      appendJsonLine(fullPath, entry);
      this.rotateAuditLog(fullPath);
    } catch (err) {
      log.error('Failed to write audit log', { error: String(err) });
    }
  }

  private rotateAuditLog(fullPath: string): void {
    const nowMs = Date.now();
    const { entries, rawLineCount } = this.readAuditLines(fullPath);
    if (rawLineCount === 0) {
      return;
    }

    const maxAgeCutoff = nowMs - this.config.auditRotation.maxAgeMs;
    let retained = entries.filter(entry => entry.timestampMs >= maxAgeCutoff);

    if (retained.length > this.config.auditRotation.maxCount) {
      retained = retained.slice(-this.config.auditRotation.maxCount);
    }

    let totalBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
    let startIndex = 0;
    while (
      startIndex < retained.length - 1
      && totalBytes > this.config.auditRotation.maxSizeBytes
    ) {
      totalBytes -= retained[startIndex].bytes;
      startIndex += 1;
    }
    if (startIndex > 0) {
      retained = retained.slice(startIndex);
    }

    if (retained.length === entries.length && rawLineCount === entries.length) {
      return;
    }

    const payload = retained.map(entry => entry.line).join('\n');
    writeFileSync(fullPath, payload.length > 0 ? payload + '\n' : '', 'utf-8');
  }

  private readAuditLines(fullPath: string): {
    entries: { line: string; timestampMs: number; bytes: number }[];
    rawLineCount: number;
  } {
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      if (typeof raw !== 'string' || raw.trim() === '') {
        return { entries: [], rawLineCount: 0 };
      }

      const lines = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      const entries = lines
        .map((line) => {
          try {
            const parsed = JSON.parse(line) as { timestamp?: unknown };
            if (typeof parsed.timestamp !== 'string') {
              return null;
            }
            const timestampMs = Date.parse(parsed.timestamp);
            if (!Number.isFinite(timestampMs)) {
              return null;
            }
            return {
              line,
              timestampMs,
              bytes: Buffer.byteLength(line + '\n', 'utf-8'),
            };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { line: string; timestampMs: number; bytes: number } => entry !== null);

      return { entries, rawLineCount: lines.length };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { entries: [], rawLineCount: 0 };
      }
      throw err;
    }
  }
}

function resolveAuditRotationConfig(overrides?: Partial<GitAuditRotationConfig>): GitAuditRotationConfig {
  const resolved = { ...DEFAULT_AUDIT_ROTATION, ...overrides };
  return {
    maxSizeBytes: asPositiveInteger('auditRotation.maxSizeBytes', resolved.maxSizeBytes),
    maxAgeMs: asPositiveInteger('auditRotation.maxAgeMs', resolved.maxAgeMs),
    maxCount: asPositiveInteger('auditRotation.maxCount', resolved.maxCount),
  };
}

function asPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return value;
}
