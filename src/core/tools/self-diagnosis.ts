import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ModelUsageQueryPort } from '../../shared/telemetry/model-usage.js';

// ── Fail-closed section vocabulary (mirrors self-status.ts) ────────────────
export type DiagnosisStatus = 'available' | 'unavailable' | 'error';

export interface DiagnosisUnavailable {
  status: 'unavailable';
  reason: string;
}

export interface DiagnosisErrored {
  status: 'error';
  reason: string;
}

export type DiagnosisFallible<T> =
  | (T & { status: 'available' })
  | DiagnosisUnavailable
  | DiagnosisErrored;

/** A top-level report section: either an available payload or a fail-closed marker. */
export type DiagnosisSection = Record<string, unknown> | DiagnosisUnavailable | DiagnosisErrored;

function unavailable(reason: string): DiagnosisUnavailable {
  return { status: 'unavailable', reason };
}

function errored(reason: string): DiagnosisErrored {
  return { status: 'error', reason };
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const newlineIndex = trimmed.indexOf('\n');
  return newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Injectable primitives (real implementations by default; overridable) ───
export interface DiagnosisStatfs {
  freeBytes: number;
  totalBytes: number;
}

export interface DiagnosisFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  isWritable(path: string): boolean;
  statfs(path: string): DiagnosisStatfs;
}

export interface DiagnosisExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type DiagnosisExec = (bin: string, args: string[], cwd?: string) => DiagnosisExecResult;

export type DiagnosisWhich = (bin: string) => string | null;

const DEFAULT_FS: DiagnosisFs = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, 'utf-8'),
  isWritable: (path) => {
    try {
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  statfs: (path) => {
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize);
    return {
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    };
  },
};

const DEFAULT_EXEC: DiagnosisExec = (bin, args, cwd) => {
  try {
    const stdout = execFileSync(bin, args, {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' && err.stderr.length > 0
        ? err.stderr
        : (err.message ?? 'command failed'),
    };
  }
};

function defaultWhich(env: Record<string, string | undefined>): DiagnosisWhich {
  return (bin) => {
    const pathEnv = env.PATH ?? '';
    if (!pathEnv) return null;
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, bin);
      try {
        if (!existsSync(candidate)) continue;
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  };
}

// ── Dependency surface ─────────────────────────────────────────────────────
export interface SelfDiagnosisPaths {
  systemDataDir: string;
  companionDataDir: string;
  workspacePath: string;
  logsDir: string;
  tempDir: string;
  backupsDir: string;
}

export interface SelfDiagnosisDeps {
  env: Record<string, string | undefined>;
  paths: SelfDiagnosisPaths;
  /** Image-snapshot git repo root created by Dockerfile `git init` (e.g. /app). */
  repoRoot: string;
  now?: () => number;
  /** Lazily-resolved model-usage query port; null when the backend cannot serve it. */
  getModelUsageQuery?: () => ModelUsageQueryPort | null;
  recentModelCallLimit?: number;
  fs?: DiagnosisFs;
  exec?: DiagnosisExec;
  which?: DiagnosisWhich;
}

const IMAGE_SNAPSHOT_COMMITTER = 'PSFN Runtime Image';
const DEFAULT_RECENT_MODEL_CALL_LIMIT = 20;
const MAX_RECENT_MODEL_CALL_LIMIT = 100;
const BEAD_ID_PATTERN = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[0-9]+)?)\b/gi;

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

// ── Git helpers ─────────────────────────────────────────────────────────────
interface GitProbe {
  present: boolean;
  branch?: string;
  commit?: string;
  committerName?: string;
  dirty?: boolean;
}

function probeGit(exec: DiagnosisExec, fs: DiagnosisFs, dir: string): GitProbe {
  if (!fs.existsSync(join(dir, '.git'))) {
    return { present: false };
  }
  const commit = exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (!commit.ok) {
    return { present: false };
  }
  const branch = exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const committer = exec('git', ['-C', dir, 'log', '-1', '--format=%cn']);
  const status = exec('git', ['-C', dir, 'status', '--porcelain']);
  return {
    present: true,
    commit: commit.stdout.trim(),
    ...(branch.ok ? { branch: branch.stdout.trim() } : {}),
    ...(committer.ok ? { committerName: committer.stdout.trim() } : {}),
    ...(status.ok ? { dirty: status.stdout.trim().length > 0 } : {}),
  };
}

// ── Section 2: repository state ──────────────────────────────────────────────
interface RepositoryState {
  imageSnapshot: DiagnosisFallible<{
    path: string;
    commit: string;
    isImageSnapshot: boolean;
    committerName?: string;
    branch?: string;
  }>;
  sourceCheckout: DiagnosisFallible<{
    path: string;
    commit: string;
    branch?: string;
    dirty?: boolean;
  }>;
  authoritativeCheckoutPath: string | null;
}

function resolveRepository(deps: SelfDiagnosisDeps, fs: DiagnosisFs, exec: DiagnosisExec): RepositoryState {
  const imageProbe = probeGit(exec, fs, deps.repoRoot);
  const imageSnapshot: RepositoryState['imageSnapshot'] = imageProbe.present && imageProbe.commit
    ? {
        status: 'available',
        path: deps.repoRoot,
        commit: imageProbe.commit,
        isImageSnapshot: imageProbe.committerName === IMAGE_SNAPSHOT_COMMITTER,
        ...(imageProbe.committerName ? { committerName: imageProbe.committerName } : {}),
        ...(imageProbe.branch ? { branch: imageProbe.branch } : {}),
      }
    : unavailable(`no git snapshot repository at image root ${deps.repoRoot}`);

  const checkoutDir = deps.env.PSFN_REPOSITORY_DIR?.trim() || join(deps.repoRoot, 'repository');
  const checkoutProbe = probeGit(exec, fs, checkoutDir);
  const isRealCheckout = checkoutProbe.present
    && !!checkoutProbe.commit
    && checkoutProbe.committerName !== IMAGE_SNAPSHOT_COMMITTER
    && checkoutDir !== deps.repoRoot;

  const sourceCheckout: RepositoryState['sourceCheckout'] = isRealCheckout
    ? {
        status: 'available',
        path: checkoutDir,
        commit: checkoutProbe.commit!,
        ...(checkoutProbe.branch ? { branch: checkoutProbe.branch } : {}),
        ...(checkoutProbe.dirty !== undefined ? { dirty: checkoutProbe.dirty } : {}),
      }
    : unavailable(
        checkoutProbe.present
          ? `git repository at ${checkoutDir} is the image snapshot, not an authoritative source checkout`
          : `no authoritative source checkout at ${checkoutDir} (set PSFN_REPOSITORY_DIR to point at a real checkout)`,
      );

  return {
    imageSnapshot,
    sourceCheckout,
    authoritativeCheckoutPath: isRealCheckout ? checkoutDir : null,
  };
}

// ── Section 1: deployment identity ───────────────────────────────────────────
function resolveFixesShipped(
  deps: SelfDiagnosisDeps,
  exec: DiagnosisExec,
  repository: RepositoryState,
): DiagnosisFallible<{ fromCommit: string; toCommit: string; beadIds: string[] }> {
  const checkout = repository.authoritativeCheckoutPath;
  if (!checkout) {
    return unavailable('no authoritative source checkout available; cannot derive shipped fixes');
  }
  const previousCommit = deps.env.PSFN_PREVIOUS_GIT_COMMIT?.trim();
  if (!previousCommit) {
    return unavailable('PSFN_PREVIOUS_GIT_COMMIT is not set; cannot compute the fixes shipped since the prior build');
  }
  const currentCommit = deps.env.PSFN_GIT_COMMIT?.trim()
    || (repository.sourceCheckout.status === 'available' ? repository.sourceCheckout.commit : undefined);
  if (!currentCommit) {
    return unavailable('current build commit is unknown; set PSFN_GIT_COMMIT');
  }
  const log = exec('git', ['-C', checkout, 'log', '--format=%s', `${previousCommit}..${currentCommit}`]);
  if (!log.ok) {
    return errored(`git log ${previousCommit}..${currentCommit} failed: ${firstLine(log.stderr)}`);
  }
  const beadIds = new Set<string>();
  for (const line of log.stdout.split('\n')) {
    const colonIndex = line.indexOf(':');
    const head = colonIndex === -1 ? line : line.slice(0, colonIndex);
    for (const match of head.matchAll(BEAD_ID_PATTERN)) {
      beadIds.add(match[1].toLowerCase());
    }
  }
  return {
    status: 'available',
    fromCommit: previousCommit,
    toCommit: currentCommit,
    beadIds: [...beadIds].sort(),
  };
}

function resolveDeployment(
  deps: SelfDiagnosisDeps,
  exec: DiagnosisExec,
  repository: RepositoryState,
): Record<string, unknown> {
  const imageTag = deps.env.PSFN_IMAGE_TAG?.trim();
  const helmRevision = deps.env.PSFN_HELM_REVISION?.trim();
  const envGitCommit = deps.env.PSFN_GIT_COMMIT?.trim();
  const snapshotCommit = repository.imageSnapshot.status === 'available'
    ? repository.imageSnapshot.commit
    : undefined;
  const gitCommit = envGitCommit || snapshotCommit;

  return {
    status: 'available',
    imageTag: imageTag || unavailable('PSFN_IMAGE_TAG is not set in this deployment'),
    helmRevision: helmRevision || unavailable('PSFN_HELM_REVISION is not set in this deployment'),
    gitCommit: gitCommit || unavailable('neither PSFN_GIT_COMMIT nor an image-snapshot commit is available'),
    gitCommitSource: envGitCommit ? 'env' : (snapshotCommit ? 'image-snapshot' : 'unknown'),
    fixesShipped: resolveFixesShipped(deps, exec, repository),
  };
}

// ── Section 3: tooling availability ──────────────────────────────────────────
function resolveTooling(deps: SelfDiagnosisDeps, fs: DiagnosisFs, which: DiagnosisWhich): Record<string, unknown> {
  const binaries: Record<string, string | null> = {};
  for (const bin of ['bd', 'rg', 'psql']) {
    binaries[bin] = which(bin);
  }

  const workspaceMarker = fs.existsSync(join(deps.paths.workspacePath, '.beads'));
  const repoMarker = fs.existsSync(join(deps.repoRoot, '.beads'));
  const markerPresent = workspaceMarker || repoMarker;
  const envFlagRaw = deps.env.BEADS_TOOLS_ENABLED?.trim();
  const envFlag = parseBooleanFlag(envFlagRaw);
  const enabled = envFlag !== undefined ? envFlag : markerPresent;

  let reason: string;
  if (envFlag !== undefined) {
    reason = `BEADS_TOOLS_ENABLED=${envFlagRaw} overrides marker detection`;
  } else if (markerPresent) {
    reason = `.beads marker present (${workspaceMarker ? 'workspace' : 'repo'} root)`;
  } else {
    reason = 'no .beads marker at workspace or repo root and BEADS_TOOLS_ENABLED unset';
  }

  return {
    status: 'available',
    binaries,
    beads: {
      enabled,
      reason,
      markerPresent,
      envFlag: envFlagRaw ?? null,
      allowActions: deps.env.BEADS_ALLOW_ACTIONS?.trim() || null,
    },
  };
}

// ── Section 4: storage ───────────────────────────────────────────────────────
function resolveStorage(deps: SelfDiagnosisDeps, fs: DiagnosisFs): Record<string, unknown> {
  const named: Array<[string, string]> = [
    ['systemData', deps.paths.systemDataDir],
    ['companionData', deps.paths.companionDataDir],
    ['workspace', deps.paths.workspacePath],
    ['logs', deps.paths.logsDir],
    ['tmp', deps.paths.tempDir],
    ['backups', deps.paths.backupsDir],
  ];
  const mounts: Record<string, unknown> = {};
  for (const [key, path] of named) {
    if (!fs.existsSync(path)) {
      mounts[key] = unavailable(`path ${path} does not exist`);
      continue;
    }
    let space: DiagnosisStatfs | null = null;
    let spaceError: string | undefined;
    try {
      space = fs.statfs(path);
    } catch (error) {
      spaceError = describeError(error);
    }
    mounts[key] = {
      status: 'available',
      path,
      writable: fs.isWritable(path),
      ...(space
        ? { freeBytes: space.freeBytes, totalBytes: space.totalBytes }
        : { freeSpace: errored(`statfs failed: ${spaceError}`) }),
    };
  }
  return { status: 'available', mounts };
}

// ── Section 5: model routing health ──────────────────────────────────────────
async function resolveModelRouting(deps: SelfDiagnosisDeps): Promise<DiagnosisSection> {
  const query = deps.getModelUsageQuery?.() ?? null;
  if (!query) {
    return unavailable('model-usage query port is not wired (non-postgres backend or store unavailable)');
  }
  const limit = Math.max(
    1,
    Math.min(MAX_RECENT_MODEL_CALL_LIMIT, deps.recentModelCallLimit ?? DEFAULT_RECENT_MODEL_CALL_LIMIT),
  );
  let data;
  try {
    data = await query.getUsageData({ callKind: 'chat', limit });
  } catch (error) {
    return errored(`model-usage query failed: ${firstLine(describeError(error))}`);
  }
  const calls = data.recentEvents.map(event => {
    const requestedProvider = event.requestedProvider ?? null;
    const requestedModel = event.requestedModel ?? null;
    const providerMismatch = requestedProvider !== null
      && requestedProvider.toLowerCase() !== event.provider.toLowerCase();
    const modelMismatch = requestedModel !== null
      && requestedModel.toLowerCase() !== event.model.toLowerCase();
    return {
      recordedAtMs: event.recordedAtMs,
      status: event.status,
      requestedProvider,
      servedProvider: event.provider,
      requestedModel,
      servedModel: event.model,
      providerMismatch,
      modelMismatch,
    };
  });
  const mismatches = calls.filter(call => call.providerMismatch || call.modelMismatch);
  return {
    status: 'available',
    inspectedCount: calls.length,
    mismatchCount: mismatches.length,
    flagged: mismatches.length > 0,
    calls,
  };
}

// ── Section 6: policy / settings flags (agent-process view) ──────────────────
function resolvePolicyFlags(deps: SelfDiagnosisDeps): Record<string, unknown> {
  const env = deps.env;
  const flag = (raw: string | undefined): { value: string | boolean | null; source: string } => {
    const parsed = parseBooleanFlag(raw);
    if (parsed !== undefined) return { value: parsed, source: 'env' };
    if (raw !== undefined && raw.trim().length > 0) return { value: raw.trim(), source: 'env' };
    return { value: null, source: 'unset' };
  };
  return {
    status: 'available',
    note: 'agent-process view of policy-relevant env; authoritative enforcement lives in the gateway process',
    beads: flag(env.BEADS_TOOLS_ENABLED),
    beadsAllowActions: flag(env.BEADS_ALLOW_ACTIONS),
    shellExec: flag(env.SHELL_EXEC_ENABLED),
    shellExecAllowlist: flag(env.SHELL_EXEC_ALLOWLIST),
    vaultTools: flag(env.VAULT_TOOLS_ENABLED),
    gitRepoRoot: flag(env.GIT_REPO_ROOT),
    web: env.WEB_TOOLS_ENABLED !== undefined
      ? flag(env.WEB_TOOLS_ENABLED)
      : { value: null, source: 'gateway-enforced' },
  };
}

// ── Section 7: tool-surface conformance ──────────────────────────────────────
interface ConformanceResultEntry {
  toolName: string;
  probeKind?: string;
  action?: string;
  ok: boolean;
  classification?: string;
  error?: string;
}

function validateConformance(raw: unknown): { ok: true; ranAt: number; results: ConformanceResultEntry[] } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'root is not an object' };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return { ok: false, reason: `unexpected schemaVersion ${JSON.stringify(record.schemaVersion)} (expected 1)` };
  }
  if (typeof record.ranAt !== 'number' || !Number.isFinite(record.ranAt)) {
    return { ok: false, reason: 'ranAt is not a finite number' };
  }
  if (!Array.isArray(record.results)) {
    return { ok: false, reason: 'results is not an array' };
  }
  const results: ConformanceResultEntry[] = [];
  for (let index = 0; index < record.results.length; index += 1) {
    const entry = record.results[index];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `results[${index}] is not an object` };
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.toolName !== 'string' || typeof item.ok !== 'boolean') {
      return { ok: false, reason: `results[${index}] is missing required toolName/ok fields` };
    }
    if (item.action !== undefined && typeof item.action !== 'string') {
      return { ok: false, reason: `results[${index}].action is not a string` };
    }
    if (item.probeKind !== undefined && typeof item.probeKind !== 'string') {
      return { ok: false, reason: `results[${index}].probeKind is not a string` };
    }
    if (item.classification !== undefined && typeof item.classification !== 'string') {
      return { ok: false, reason: `results[${index}].classification is not a string` };
    }
    if (item.error !== undefined && typeof item.error !== 'string') {
      return { ok: false, reason: `results[${index}].error is not a string` };
    }
    results.push({
      toolName: item.toolName,
      ...(item.probeKind !== undefined ? { probeKind: item.probeKind } : {}),
      ...(item.action !== undefined ? { action: item.action } : {}),
      ok: item.ok,
      ...(item.classification !== undefined ? { classification: item.classification } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    });
  }
  return { ok: true, ranAt: record.ranAt, results };
}

function resolveConformance(deps: SelfDiagnosisDeps, fs: DiagnosisFs): DiagnosisSection {
  const path = join(deps.paths.systemDataDir, 'state', 'tool-conformance-latest.json');
  if (!fs.existsSync(path)) {
    return { status: 'available', recorded: false, note: 'no conformance run recorded' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path));
  } catch (error) {
    return errored(`conformance file is not valid JSON: ${firstLine(describeError(error))}`);
  }
  const validated = validateConformance(parsed);
  if (!validated.ok) {
    return errored(`conformance file failed schema validation: ${validated.reason}`);
  }
  const failing = validated.results.filter(entry => !entry.ok);
  return {
    status: 'available',
    recorded: true,
    ranAt: validated.ranAt,
    total: validated.results.length,
    passCount: validated.results.length - failing.length,
    failCount: failing.length,
    failing: failing.map(entry => ({
      toolName: entry.toolName,
      action: entry.action,
      ...(entry.classification !== undefined ? { classification: entry.classification } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    })),
  };
}

// ── Redaction pass (defense-in-depth over the assembled report) ──────────────
const SECRET_KEY_PATTERN = /(password|passwd|secret|token|apikey|api[_-]?key|credential|hmac|authorization|bearer|private[_-]?key)/i;
const REDACTION_PLACEHOLDER = '[REDACTED]';

export function redactSecretString(value: string): string {
  let out = value;
  // Credentials embedded in URIs: scheme://user:password@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, `$1${REDACTION_PLACEHOLDER}$2`);
  // Bearer / token= style secrets
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTION_PLACEHOLDER}`);
  out = out.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s;,'"]+/gi, `$1${REDACTION_PLACEHOLDER}`);
  // Common provider key prefixes.
  out = out.replace(/\b(sk|xox[baprs]|ghp|gho|glpat)-[A-Za-z0-9._-]{8,}\b/g, REDACTION_PLACEHOLDER);
  return out;
}

export function redactDeep(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return REDACTION_PLACEHOLDER;
    return redactSecretString(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactDeep(item, keyHint));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key) && typeof inner === 'string') {
        out[key] = REDACTION_PLACEHOLDER;
      } else {
        out[key] = redactDeep(inner, key);
      }
    }
    return out;
  }
  return value;
}

// ── Report assembly ──────────────────────────────────────────────────────────
export async function buildSelfDiagnosisReport(deps: SelfDiagnosisDeps): Promise<Record<string, unknown>> {
  const fs = deps.fs ?? DEFAULT_FS;
  const exec = deps.exec ?? DEFAULT_EXEC;
  const which = deps.which ?? defaultWhich(deps.env);
  const now = deps.now?.() ?? Date.now();

  const repository = resolveRepository(deps, fs, exec);

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    action: 'diagnose',
    generatedAt: now,
    deployment: resolveDeployment(deps, exec, repository),
    repository: {
      status: 'available',
      imageSnapshot: repository.imageSnapshot,
      sourceCheckout: repository.sourceCheckout,
    },
    tooling: resolveTooling(deps, fs, which),
    storage: resolveStorage(deps, fs),
    modelRouting: await resolveModelRouting(deps),
    policy: resolvePolicyFlags(deps),
    toolConformance: resolveConformance(deps, fs),
  };

  return redactDeep(report) as Record<string, unknown>;
}
