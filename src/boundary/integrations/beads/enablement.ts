// ── Beads tool enablement resolution ──
// Single source of truth for "are beads tools enabled" so the gateway policy
// (which DENYs beads.* when disabled) and the agent-side tool registration
// agree. Registering the beads tool while the gateway policy denies it makes
// the tool advertise but fail at every call (psfn-framework-e7s0); the agent
// gates registration on this same resolver so registration and policy match,
// fail-closed.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBooleanEnv, parseEnvList } from '../../../shared/utils/env.js';

export const ALL_BEADS_ACTIONS = ['ready', 'show', 'create', 'update', 'close', 'sync'] as const;

export type BeadsAction = (typeof ALL_BEADS_ACTIONS)[number];
export type BeadsCallerClass = 'companion' | 'shard';

/**
 * Main-companion tracked-work policy: reads and recoverable mutations are
 * available, while consequential closure belongs only to the shard-owned
 * predicate enforced by the gateway.
 */
export const COMPANION_BEADS_ACTIONS: readonly BeadsAction[] = Object.freeze([
  'ready',
  'show',
  'create',
  'update',
  'sync',
]);

export interface BeadsEnablementRoots {
  workspaceRoot: string;
  codebaseRoot: string;
  /** bd's own `BEADS_DIR` override (the `.beads` directory itself), inherited by the gateway's bd child. */
  beadsDir?: string;
}

export type BeadsToolsEnablement =
  | { enabled: true; databaseDir: string }
  | {
    enabled: false;
    /**
     * `disabled_by_policy`: BEADS_TOOLS_ENABLED=false.
     * `not_discovered`: unset and no database found (dev-convenience fallback).
     * `database_missing`: BEADS_TOOLS_ENABLED=true but no Beads database is
     * provisioned, so every call would fail with "no beads database found".
     */
    reason: 'disabled_by_policy' | 'not_discovered' | 'database_missing';
    searched: string[];
  };

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Resolve whether beads tools are enabled. The tool is registered (agent) and
 * permitted (gateway policy) only when a Beads database is actually
 * provisioned where the gateway's `bd` child will look for it: `BEADS_DIR`
 * when set, else a `.beads` directory at the workspace or codebase root.
 * An explicit BEADS_TOOLS_ENABLED=false always wins; an explicit `true` with
 * no provisioned database fails closed at registration time
 * (psfn-framework-povuo) instead of advertising a tool whose every call fails.
 */
export function resolveBeadsToolsEnablement(
  value: string | undefined,
  roots: BeadsEnablementRoots,
): BeadsToolsEnablement {
  const parsed = parseBooleanEnv(value);
  const beadsDir = roots.beadsDir?.trim();
  const candidates = beadsDir
    ? [resolve(beadsDir)]
    : [resolve(roots.workspaceRoot, '.beads'), resolve(roots.codebaseRoot, '.beads')];
  if (parsed === false) {
    return { enabled: false, reason: 'disabled_by_policy', searched: [] };
  }
  const databaseDir = candidates.find(isDirectory);
  if (databaseDir) return { enabled: true, databaseDir };
  return {
    enabled: false,
    reason: parsed === true ? 'database_missing' : 'not_discovered',
    searched: candidates,
  };
}

export function parseBeadsActionsEnv(value: string | undefined): BeadsAction[] | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set<string>(ALL_BEADS_ACTIONS);
  const actions: BeadsAction[] = [];
  for (const entry of parsed) {
    const normalized = entry.toLowerCase();
    if (valid.has(normalized)) {
      actions.push(normalized as BeadsAction);
    }
  }
  return actions;
}

/**
 * Resolve the caller-visible action surface from the same environment policy
 * consumed by gateway bootstrap. `close` is never a flat deployment grant:
 * only a shard catalog receives it, and the gateway separately proves target
 * ownership before dispatch.
 */
export function resolveBeadsActionsForCaller(
  value: string | undefined,
  callerClass: BeadsCallerClass,
): BeadsAction[] {
  return resolveConfiguredBeadsActionsForCaller(
    parseBeadsActionsEnv(value) ?? COMPANION_BEADS_ACTIONS,
    callerClass,
  );
}

export function resolveConfiguredBeadsActionsForCaller(
  configured: readonly BeadsAction[],
  callerClass: BeadsCallerClass,
): BeadsAction[] {
  const configuredActions = new Set(configured);
  const companionActions = COMPANION_BEADS_ACTIONS.filter(action => configuredActions.has(action));
  return callerClass === 'shard'
    ? [...companionActions, 'close']
    : companionActions;
}
