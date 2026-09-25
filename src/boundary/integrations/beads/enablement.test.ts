import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_BEADS_ACTIONS,
  COMPANION_BEADS_ACTIONS,
  parseBeadsActionsEnv,
  resolveBeadsActionsForCaller,
  resolveBeadsToolsEnablement,
} from './enablement.js';

// Regression coverage for psfn-framework-e7s0: the agent registration and the
// gateway policy must agree on beads enablement via this single resolver, so
// the agent never advertises a tool the gateway policy will deny.
describe('resolveBeadsToolsEnablement', () => {
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

  it('enables an explicit BEADS_TOOLS_ENABLED=true when the workspace database is provisioned', () => {
    mkdirSync(join(workspaceRoot, '.beads'));
    expect(resolveBeadsToolsEnablement('true', { workspaceRoot, codebaseRoot })).toEqual({
      enabled: true,
      databaseDir: join(workspaceRoot, '.beads'),
    });
  });

  // psfn-framework-povuo: explicit enablement without a database must not
  // advertise a tool whose every call fails with "no beads database found".
  it('fails closed at registration when BEADS_TOOLS_ENABLED=true but no database is provisioned', () => {
    expect(resolveBeadsToolsEnablement('true', { workspaceRoot, codebaseRoot })).toEqual({
      enabled: false,
      reason: 'database_missing',
      searched: [join(workspaceRoot, '.beads'), join(codebaseRoot, '.beads')],
    });
  });

  it('does not treat a plain .beads file as a database', () => {
    writeFileSync(join(workspaceRoot, '.beads'), '');
    expect(resolveBeadsToolsEnablement('true', { workspaceRoot, codebaseRoot }).enabled).toBe(false);
  });

  it('uses only BEADS_DIR when it is set, exactly as the bd child resolves it', () => {
    mkdirSync(join(workspaceRoot, '.beads'));
    const beadsDir = join(codebaseRoot, 'provisioned-beads');
    expect(resolveBeadsToolsEnablement('true', { workspaceRoot, codebaseRoot, beadsDir })).toEqual({
      enabled: false,
      reason: 'database_missing',
      searched: [beadsDir],
    });
    mkdirSync(beadsDir);
    expect(resolveBeadsToolsEnablement('true', { workspaceRoot, codebaseRoot, beadsDir })).toEqual({
      enabled: true,
      databaseDir: beadsDir,
    });
  });

  it('honors an explicit BEADS_TOOLS_ENABLED=false override even when .beads exists', () => {
    mkdirSync(join(workspaceRoot, '.beads'));
    expect(resolveBeadsToolsEnablement('false', { workspaceRoot, codebaseRoot })).toEqual({
      enabled: false,
      reason: 'disabled_by_policy',
      searched: [],
    });
  });

  it('falls back to disabled (fail-closed) when unset and no .beads directory exists', () => {
    expect(resolveBeadsToolsEnablement(undefined, { workspaceRoot, codebaseRoot })).toMatchObject({
      enabled: false,
      reason: 'not_discovered',
    });
  });

  it('falls back to enabled when unset and a .beads directory exists at either root', () => {
    mkdirSync(join(codebaseRoot, '.beads'));
    expect(resolveBeadsToolsEnablement(undefined, { workspaceRoot, codebaseRoot }).enabled).toBe(true);
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
