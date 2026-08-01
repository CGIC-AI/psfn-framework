import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_BEADS_ACTIONS,
  COMPANION_BEADS_ACTIONS,
  parseBeadsActionsEnv,
  resolveBeadsActionsForCaller,
  resolveBeadsToolsEnabled,
} from './enablement.js';

// Regression coverage for psfn-framework-e7s0: the agent registration and the
// gateway policy must agree on beads enablement via this single resolver, so
// the agent never advertises a tool the gateway policy will deny.
describe('resolveBeadsToolsEnabled', () => {
  let workspaceRoot: string;
  let codebaseRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'beads-ws-'));
    codebaseRoot = mkdtempSync(join(tmpdir(), 'beads-cb-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codebaseRoot, { recursive: true, force: true });
  });

  it('honors an explicit BEADS_TOOLS_ENABLED=true override', () => {
    expect(resolveBeadsToolsEnabled('true', { workspaceRoot, codebaseRoot })).toBe(true);
  });

  it('honors an explicit BEADS_TOOLS_ENABLED=false override even when .beads exists', () => {
    mkdirSync(join(workspaceRoot, '.beads'));
    expect(resolveBeadsToolsEnabled('false', { workspaceRoot, codebaseRoot })).toBe(false);
  });

  it('falls back to false (fail-closed) when unset and no .beads directory exists', () => {
    expect(resolveBeadsToolsEnabled(undefined, { workspaceRoot, codebaseRoot })).toBe(false);
  });

  it('falls back to true when unset and a .beads directory exists at either root', () => {
    mkdirSync(join(codebaseRoot, '.beads'));
    expect(resolveBeadsToolsEnabled(undefined, { workspaceRoot, codebaseRoot })).toBe(true);
  });
});

describe('parseBeadsActionsEnv', () => {
  it('returns undefined when unset so callers can apply their default', () => {
    expect(parseBeadsActionsEnv(undefined)).toBeUndefined();
  });

  it('parses and lowercases a valid action list, dropping unknown actions', () => {
    expect(parseBeadsActionsEnv('Ready, show ,bogus')).toEqual(['ready', 'show']);
  });

  it('returns an empty list for a present-but-empty value', () => {
    expect(parseBeadsActionsEnv('')).toEqual([]);
  });

  it('accepts the full action set', () => {
    expect(parseBeadsActionsEnv(ALL_BEADS_ACTIONS.join(','))).toEqual([...ALL_BEADS_ACTIONS]);
  });
});

describe('resolveBeadsActionsForCaller', () => {
  it('defaults the companion to every permitted recoverable action and withholds close', () => {
    expect(resolveBeadsActionsForCaller(undefined, 'companion')).toEqual(COMPANION_BEADS_ACTIONS);
    expect(resolveBeadsActionsForCaller(undefined, 'companion')).not.toContain('close');
  });

  it('intersects a partial deployment allowlist with the companion surface', () => {
    expect(resolveBeadsActionsForCaller('ready,create,close', 'companion'))
      .toEqual(['ready', 'create']);
  });

  it('adds close only for a shard caller while preserving the deployment action subset', () => {
    expect(resolveBeadsActionsForCaller('ready,create', 'shard'))
      .toEqual(['ready', 'create', 'close']);
  });
});
