import { spawn } from 'node:child_process';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  BeadsAction,
  BeadsActionResult,
  BeadsCloseParams,
  BeadsCreateParams,
  BeadsIssueStatus,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsSyncParams,
  BeadsUpdateParams,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { toErrorMessage } from '../../utils/errors.js';

const DEFAULT_BD_TIMEOUT_MS = 12_000;
const MAX_BD_OUTPUT_CHARS = 250_000;
const MAX_ISSUE_REF_CHARS = 128;
const MAX_TITLE_CHARS = 200;
const MAX_REASON_CHARS = 400;
const MAX_ACTOR_CHARS = 64;
const MAX_DEPENDENCIES = 16;

const ISSUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BEADS_ISSUE_TYPES = new Set(['bug', 'feature', 'task', 'epic', 'chore']);
const BEADS_ISSUE_STATUSES = new Set(['open', 'in_progress', 'blocked', 'closed']);
const DEFAULT_ACTOR = 'runtime-agent';

function deny(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.POLICY_DENIED);
}

function normalizeActor(value: unknown): string {
  if (value === undefined) return DEFAULT_ACTOR;
  if (typeof value !== 'string') {
    deny('beads actor must be a string');
  }
  const actor = value.trim();
  if (!actor) {
    deny('beads actor must be non-empty when provided');
  }
  if (actor.length > MAX_ACTOR_CHARS || !ACTOR_PATTERN.test(actor)) {
    deny('beads actor contains invalid characters or is too long');
  }
  return actor;
}

function parseIssueRef(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    deny(`${field} must be a string`);
  }
  const ref = value.trim();
  if (!ref) {
    deny(`${field} is required`);
  }
  if (ref.length > MAX_ISSUE_REF_CHARS || !ISSUE_REF_PATTERN.test(ref) || ref.includes(',')) {
    deny(`${field} contains invalid characters`);
  }
  return ref;
}

function parseIssueTitle(value: unknown): string {
  if (typeof value !== 'string') {
    deny('beads.create title must be a string');
  }
  const title = value.trim();
  if (!title) {
    deny('beads.create title is required');
  }
  if (title.length > MAX_TITLE_CHARS || title.includes('\0')) {
    deny('beads.create title is invalid or too long');
  }
  return title;
}

function parseCloseReason(value: unknown): string {
  if (typeof value !== 'string') {
    deny('beads.close reason must be a string');
  }
  const reason = value.trim();
  if (!reason) {
    deny('beads.close reason is required');
  }
  if (reason.length > MAX_REASON_CHARS || reason.includes('\0')) {
    deny('beads.close reason is invalid or too long');
  }
  return reason;
}

function parseIssueType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    deny('beads.create issueType must be a string');
  }
  const issueType = value.trim().toLowerCase();
  if (!BEADS_ISSUE_TYPES.has(issueType)) {
    deny(`Unsupported issue type "${issueType}"`);
  }
  return issueType;
}

function parseIssueStatus(value: unknown): BeadsIssueStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    deny('beads.update status must be a string');
  }
  const status = value.trim().toLowerCase();
  if (!BEADS_ISSUE_STATUSES.has(status)) {
    deny(`Unsupported issue status "${status}"`);
  }
  return status as BeadsIssueStatus;
}

function parsePriority(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    deny(`${field} must be an integer between 0 and 4`);
  }
  const normalized = Math.floor(value);
  if (normalized < 0 || normalized > 4) {
    deny(`${field} must be an integer between 0 and 4`);
  }
  return normalized;
}

function parseDependencies(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    deny('beads.create deps must be an array of dependency references');
  }
  if (value.length > MAX_DEPENDENCIES) {
    deny(`beads.create deps exceeds max length (${MAX_DEPENDENCIES})`);
  }

  const deps: string[] = [];
  for (const entry of value) {
    deps.push(parseIssueRef(entry, 'dependency'));
  }
  return deps;
}

function parseBdJson(stdout: string, action: BeadsAction): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new JSONRPCErrorException(
      `beads.${action} returned invalid JSON: ${toErrorMessage(error)}`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

async function runBdCommand(
  action: BeadsAction,
  args: readonly string[],
  runtime: GatewayMethodRuntime,
): Promise<unknown> {
  return await new Promise<unknown>((resolveResult, rejectResult) => {
    const child = spawn('bd', [action, ...args, '--json'], {
      cwd: runtime.workspacePath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let totalChars = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const finalize = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn();
    };

    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (!text) return;

      const remaining = MAX_BD_OUTPUT_CHARS - totalChars;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const next = text.length > remaining ? text.slice(0, remaining) : text;
      totalChars += next.length;
      if (target === 'stdout') stdout += next;
      else stderr += next;
      if (next.length < text.length) {
        truncated = true;
      }
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, DEFAULT_BD_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));

    child.once('error', (error) => {
      finalize(() => {
        rejectResult(new JSONRPCErrorException(
          `beads.${action} failed to start: ${toErrorMessage(error)}`,
          GatewayErrors.PROVIDER_ERROR,
        ));
      });
    });

    child.once('close', (code) => {
      finalize(() => {
        if (timedOut) {
          rejectResult(new JSONRPCErrorException(
            `beads.${action} timed out after ${DEFAULT_BD_TIMEOUT_MS}ms`,
            GatewayErrors.PROVIDER_ERROR,
          ));
          return;
        }
        if (truncated) {
          rejectResult(new JSONRPCErrorException(
            `beads.${action} output exceeded ${MAX_BD_OUTPUT_CHARS} chars`,
            GatewayErrors.PROVIDER_ERROR,
          ));
          return;
        }
        if (code !== 0) {
          const errorDetails = stderr.trim() || stdout.trim() || `exit code ${code}`;
          rejectResult(new JSONRPCErrorException(
            `beads.${action} failed: ${errorDetails}`,
            GatewayErrors.PROVIDER_ERROR,
          ));
          return;
        }
        resolveResult(parseBdJson(stdout, action));
      });
    });
  });
}

function recordBeadsAudit(
  runtime: GatewayMethodRuntime,
  event: {
    actor: string;
    action: BeadsAction;
    target: string;
    result: 'success' | 'error';
  },
  durationMs: number,
  error?: string,
): void {
  runtime.recordAuditEvent?.({
    method: 'beads.action',
    decision: event.result === 'success' ? 'ALLOW' : 'DENY',
    params: event,
    durationMs,
    ...(error ? { error } : {}),
  });
}

async function executeBeadsAction(
  runtime: GatewayMethodRuntime,
  action: BeadsAction,
  actor: string,
  target: string,
  buildArgs: () => string[],
): Promise<BeadsActionResult> {
  const startedAt = Date.now();
  try {
    const args = buildArgs();
    const payload = await runBdCommand(action, args, runtime);
    recordBeadsAudit(runtime, {
      actor,
      action,
      target,
      result: 'success',
    }, Date.now() - startedAt);
    return {
      actor,
      action,
      target,
      result: 'success',
      payload,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    recordBeadsAudit(runtime, {
      actor,
      action,
      target,
      result: 'error',
    }, Date.now() - startedAt, message);
    throw error;
  }
}

function summaryActor(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, MAX_ACTOR_CHARS)
    : DEFAULT_ACTOR;
}

const beadsDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'beads.ready',
    handler: async (params: BeadsReadyParams, runtime) => {
      const actor = normalizeActor(params.actor);
      return executeBeadsAction(runtime, 'ready', actor, 'ready', () => []);
    },
    summary: (params: BeadsReadyParams) => ({
      actor: summaryActor(params.actor),
      action: 'ready',
      target: 'ready',
    }),
    approvalAction: 'issue.read',
    approvalScope: () => 'ready',
  },
  {
    name: 'beads.show',
    handler: async (params: BeadsShowParams, runtime) => {
      const actor = normalizeActor(params.actor);
      const id = parseIssueRef(params.id, 'id');
      return executeBeadsAction(runtime, 'show', actor, id, () => [id]);
    },
    summary: (params: BeadsShowParams) => ({
      actor: summaryActor(params.actor),
      action: 'show',
      target: typeof params.id === 'string' ? params.id : '<invalid>',
    }),
    approvalAction: 'issue.read',
    approvalScope: (params: BeadsShowParams) => (
      typeof params.id === 'string' ? params.id : 'unknown'
    ),
  },
  {
    name: 'beads.create',
    handler: async (params: BeadsCreateParams, runtime) => {
      const actor = normalizeActor(params.actor);
      return executeBeadsAction(runtime, 'create', actor, 'new', () => {
        const title = parseIssueTitle(params.title);
        const issueType = parseIssueType(params.issueType);
        const priority = parsePriority(params.priority, 'beads.create priority');
        const deps = parseDependencies(params.deps);
        const parent = params.parent === undefined
          ? undefined
          : parseIssueRef(params.parent, 'parent');

        const args = [title];
        if (issueType) {
          args.push('-t', issueType);
        }
        if (priority !== undefined) {
          args.push('-p', String(priority));
        }
        if (deps.length > 0) {
          args.push('--deps', deps.join(','));
        }
        if (parent) {
          args.push('--parent', parent);
        }
        return args;
      });
    },
    summary: (params: BeadsCreateParams) => ({
      actor: summaryActor(params.actor),
      action: 'create',
      target: 'new',
      issueType: params.issueType,
      hasParent: typeof params.parent === 'string' && params.parent.trim().length > 0,
      dependencyCount: Array.isArray(params.deps) ? params.deps.length : 0,
    }),
    approvalAction: 'issue.write',
    approvalScope: () => 'create',
  },
  {
    name: 'beads.update',
    handler: async (params: BeadsUpdateParams, runtime) => {
      const actor = normalizeActor(params.actor);
      const id = parseIssueRef(params.id, 'id');
      return executeBeadsAction(runtime, 'update', actor, id, () => {
        const status = parseIssueStatus(params.status);
        const priority = parsePriority(params.priority, 'beads.update priority');
        if (!status && priority === undefined) {
          deny('beads.update requires at least one of status or priority');
        }

        const args = [id];
        if (status) {
          args.push('--status', status);
        }
        if (priority !== undefined) {
          args.push('--priority', String(priority));
        }
        return args;
      });
    },
    summary: (params: BeadsUpdateParams) => ({
      actor: summaryActor(params.actor),
      action: 'update',
      target: typeof params.id === 'string' ? params.id : '<invalid>',
      status: params.status,
      priority: params.priority,
    }),
    approvalAction: 'issue.write',
    approvalScope: (params: BeadsUpdateParams) => (
      typeof params.id === 'string' ? params.id : 'unknown'
    ),
  },
  {
    name: 'beads.close',
    handler: async (params: BeadsCloseParams, runtime) => {
      const actor = normalizeActor(params.actor);
      const id = parseIssueRef(params.id, 'id');
      return executeBeadsAction(runtime, 'close', actor, id, () => {
        const reason = parseCloseReason(params.reason);
        return [id, '--reason', reason];
      });
    },
    summary: (params: BeadsCloseParams) => ({
      actor: summaryActor(params.actor),
      action: 'close',
      target: typeof params.id === 'string' ? params.id : '<invalid>',
    }),
    approvalAction: 'issue.close',
    approvalScope: (params: BeadsCloseParams) => (
      typeof params.id === 'string' ? params.id : 'unknown'
    ),
  },
  {
    name: 'beads.sync',
    handler: async (params: BeadsSyncParams, runtime) => {
      const actor = normalizeActor(params.actor);
      return executeBeadsAction(runtime, 'sync', actor, 'sync', () => []);
    },
    summary: (params: BeadsSyncParams) => ({
      actor: summaryActor(params.actor),
      action: 'sync',
      target: 'sync',
    }),
    approvalAction: 'issue.close',
    approvalScope: () => 'sync',
  },
];

export function registerBeadsMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, beadsDescriptors);
}
