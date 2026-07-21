import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUBAGENT_ROLES_FILE_NAME,
  loadSubagentRolesConfig,
  saveSubagentRolesConfig,
} from './subagent-roles-config.js';

describe('subagent-roles owner file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-subagent-roles-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the empty registry when the owner file is absent (feature unconfigured)', () => {
    expect(loadSubagentRolesConfig(dir).roles).toEqual({});
  });

  it('loads and validates a well-formed owner file', () => {
    writeFileSync(
      join(dir, SUBAGENT_ROLES_FILE_NAME),
      JSON.stringify({ roles: { reviewer: { instructions: 'Review adversarially.' } } }),
    );
    const config = loadSubagentRolesConfig(dir);
    expect(config.roles.reviewer.instructions).toBe('Review adversarially.');
  });

  it('fails closed on a malformed (non-JSON) owner file', () => {
    writeFileSync(join(dir, SUBAGENT_ROLES_FILE_NAME), '{ not json');
    expect(() => loadSubagentRolesConfig(dir)).toThrow();
  });

  it('fails closed on a schema-invalid owner file', () => {
    writeFileSync(
      join(dir, SUBAGENT_ROLES_FILE_NAME),
      JSON.stringify({ roles: { broken: { maxTurns: 3 } } }),
    );
    expect(() => loadSubagentRolesConfig(dir)).toThrow(/instructions must be a non-empty string/);
  });

  it('validates and persists through save (round-trips)', () => {
    const saved = saveSubagentRolesConfig(dir, {
      roles: { implementer: { instructions: 'Do the bounded change.' } },
    });
    expect(saved.roles.implementer.instructions).toBe('Do the bounded change.');
    expect(loadSubagentRolesConfig(dir).roles.implementer.instructions)
      .toBe('Do the bounded change.');
  });

  it('save fails closed on invalid content', () => {
    expect(() => saveSubagentRolesConfig(dir, { roles: { bad: {} } }))
      .toThrow(/instructions must be a non-empty string/);
  });
});
