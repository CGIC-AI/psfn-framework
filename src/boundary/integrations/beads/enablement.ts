// ── Beads tool enablement resolution ──
// Single source of truth for "are beads tools enabled" so the gateway policy
// (which DENYs beads.* when disabled) and the agent-side tool registration
// agree. Registering the beads tool while the gateway policy denies it makes
// the tool advertise but fail at every call (psfn-framework-e7s0); the agent
// gates registration on this same resolver so registration and policy match,
// fail-closed.

import { existsSync } from 'node:fs';
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
}

/**
 * Resolve whether beads tools are enabled. An explicit BEADS_TOOLS_ENABLED
 * env value wins; otherwise fall back to whether a `.beads` directory exists at
 * the workspace or codebase root (single-process dev convenience).
 */
export function resolveBeadsToolsEnabled(
  value: string | undefined,
  roots: BeadsEnablementRoots,
): boolean {
  const parsed = parseBooleanEnv(value);
  if (parsed !== undefined) {
    return parsed;
  }
  return existsSync(resolve(roots.workspaceRoot, '.beads'))
    || existsSync(resolve(roots.codebaseRoot, '.beads'));
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
