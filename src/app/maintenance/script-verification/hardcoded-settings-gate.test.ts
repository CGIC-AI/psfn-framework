import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve('scripts/verify-hardcoded-settings.mjs');
const BASELINE_RELATIVE_PATH = 'scripts/hardcoded-settings-baseline.json';
const roots: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-hardcoded-settings-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

function writeSource(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function writeBaseline(root: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(join(root, BASELINE_RELATIVE_PATH), `${JSON.stringify({ entries }, null, 2)}\n`);
}

function run(root: string, ...extraArgs: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Hardcoded-settings repository gate', () => {
  it('passes when every matching constant is recorded in the baseline', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'export const REQUEST_TIMEOUT_MS = 5_000;\n');
    writeBaseline(root, [{ file: 'src/policy.ts', name: 'REQUEST_TIMEOUT_MS', value: '5_000' }]);

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[verify-hardcoded-settings] passed');
  });

  it('fails on a new hardcoded tuning constant that is not baselined', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'const RETRY_LIMIT = 3;\n');
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[verify-hardcoded-settings] failed');
    expect(result.stderr).toContain('new hardcoded tuning/policy constant');
    expect(result.stderr).toContain('src/policy.ts:1 RETRY_LIMIT = 3');
    expect(result.stderr).toContain('Migrate it to an owned setting');
  });

  it('fails on a stale baseline entry whose constant no longer exists', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'export const REQUEST_TIMEOUT_MS = 5_000;\n');
    writeBaseline(root, [
      { file: 'src/policy.ts', name: 'REQUEST_TIMEOUT_MS', value: '5_000' },
      { file: 'src/removed.ts', name: 'OLD_MAX_ATTEMPTS', value: '9' },
    ]);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale baseline entry');
    expect(result.stderr).toContain('src/removed.ts::OLD_MAX_ATTEMPTS');
  });

  it('fails closed when the baseline file is missing', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'export const REQUEST_TIMEOUT_MS = 5_000;\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline file is missing');
  });

  it('fails closed on malformed baseline JSON', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'export const REQUEST_TIMEOUT_MS = 5_000;\n');
    writeFileSync(join(root, BASELINE_RELATIVE_PATH), '{ not json');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid JSON');
  });

  it('ignores constants without a tuning/policy name token', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'export const DEFAULT_GREETING_COUNT = 3;\n');
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('ignores derived values that reference other identifiers or calls', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'const BASE = 1_000;',
        'export const REQUEST_TIMEOUT_MS = BASE * 5;',
        'export const RETRY_LIMIT = computeLimit();',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts numeric-literal arithmetic expressions as hardcoded values', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'const SESSION_MAX_BYTES = 8 * 1024 * 1024;\n');
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/policy.ts:1 SESSION_MAX_BYTES = 8 * 1024 * 1024');
  });

  it('ignores tuning constants defined in test files', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.test.ts', 'const RETRY_LIMIT = 3;\n');
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('regenerates the baseline with --update, preserving justification notes', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'const RETRY_LIMIT = 3;\n');
    writeSource(root, 'src/guard.ts', 'const MAX_UPLOAD_BYTES = 4 * 1024;\n');
    writeBaseline(root, [
      { file: 'src/guard.ts', name: 'MAX_UPLOAD_BYTES', value: '4 * 1024', note: 'zip-bomb guard' },
      { file: 'src/gone.ts', name: 'STALE_TIMEOUT_MS', value: '1' },
    ]);

    const updateResult = run(root, '--update');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    const baseline = JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), 'utf8')) as {
      entries: Array<{ file: string; name: string; note?: string }>;
    };
    const keys = baseline.entries.map(entry => `${entry.file}::${entry.name}`).sort();
    expect(keys).toEqual(['src/guard.ts::MAX_UPLOAD_BYTES', 'src/policy.ts::RETRY_LIMIT']);
    const guard = baseline.entries.find(entry => entry.name === 'MAX_UPLOAD_BYTES');
    expect(guard?.note).toBe('zip-bomb guard');

    // The regenerated baseline now passes verification.
    const verifyResult = run(root);
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
  });
});
