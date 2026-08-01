import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runHardcodedSettingsCommand,
} from '../../../../scripts/verify-hardcoded-settings.mjs';

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
  let stdout = '';
  let stderr = '';
  const status = runHardcodedSettingsCommand(['--root', root, ...extraArgs], {
    log: (...values: unknown[]) => {
      stdout += `${values.map(String).join(' ')}\n`;
    },
    error: (...values: unknown[]) => {
      stderr += `${values.map(String).join(' ')}\n`;
    },
  });
  return { status, stdout, stderr };
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

    const updateResult = run(root, '--update');
    expect(updateResult.status).toBe(1);
    expect(updateResult.stderr).toContain('cannot update invalid');
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

  it('flags policy regexes and ignores regexes without a policy-shaped name', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'const GENERIC_ASSISTANT_PATTERN = /\\bhelpful\\s+assistant\\b/iu;',
        "const PERSONA_POLICY_REGEX = new RegExp('assistant', 'iu');",
        "const IMAGE_EDIT_REQUEST_MARKER = RegExp('(?:edit|modify)', 'iu');",
        "const sourcePattern = 'assistant';",
        "const DYNAMIC_POLICY_REGEX = new RegExp(sourcePattern, 'iu');",
        'const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}$/u;',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GENERIC_ASSISTANT_PATTERN = /\\bhelpful\\s+assistant\\b/iu');
    expect(result.stderr).toContain("PERSONA_POLICY_REGEX = new RegExp('assistant', 'iu')");
    expect(result.stderr).toContain("IMAGE_EDIT_REQUEST_MARKER = RegExp('(?:edit|modify)', 'iu')");
    expect(result.stderr).toContain("DYNAMIC_POLICY_REGEX = new RegExp(sourcePattern, 'iu')");
    expect(result.stderr).not.toContain('ISO_DATE');
  });

  it('flags literal policy arrays and readonly tuples but ignores ordinary literal arrays', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        "const RETRY_STATES = ['queued', 'running'] as const;",
        'const TIMEOUT_STEPS: readonly [number, number] = [1_000, 5_000];',
        "const MONTH_NAMES = ['Jan', 'Feb'];",
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RETRY_STATES = ['queued', 'running'] as const");
    expect(result.stderr).toContain('TIMEOUT_STEPS = [1_000, 5_000]');
    expect(result.stderr).not.toContain('MONTH_NAMES');
  });

  it('flags tuning members in object literals but ignores ordinary literal members', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        "const dynamicKey = 'retryLimit';",
        'const requestPolicy = {',
        '  retryLimit: 3,',
        '  maxAttempts: 4,',
        '  minConfidence: 0.8,',
        "  ['retryDelayMs']: 250,",
        '  [`timeoutMs`]: 5_000,',
        '  [dynamicKey]: 9,',
        '  max: 10,',
        '  min: 1,',
        '  port: 8080,',
        '};',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requestPolicy.retryLimit = 3');
    expect(result.stderr).toContain('requestPolicy.maxAttempts = 4');
    expect(result.stderr).toContain('requestPolicy.minConfidence = 0.8');
    expect(result.stderr).toContain('requestPolicy.retryDelayMs = 250');
    expect(result.stderr).toContain('requestPolicy.timeoutMs = 5_000');
    expect(result.stderr).not.toContain('requestPolicy.dynamicKey');
    expect(result.stderr).not.toContain('requestPolicy.max = 10');
    expect(result.stderr).not.toContain('requestPolicy.min = 1');
    expect(result.stderr).not.toContain('requestPolicy.port');
  });

  it('flags tuning members in returned, assigned, and call-argument object literals', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'function buildOptions() {',
        '  return { retryLimit: 3, port: 8080 };',
        '}',
        'configureClient({ timeoutMs: 5_000, port: 8080 });',
        'let options;',
        'options = { budgetCap: 5, port: 8080 };',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('buildOptions.retryLimit = 3');
    expect(result.stderr).toContain('configureClient.arg0.timeoutMs = 5_000');
    expect(result.stderr).toContain('options.budgetCap = 5');
    expect(result.stderr).not.toContain('.port');
  });

  it('flags policy enum members but ignores ordinary enum members', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'enum RequestPolicy { RETRY_LIMIT = 3, MODE = 4 }',
        "enum Color { Red = 'red', Blue = 'blue' }",
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RequestPolicy.RETRY_LIMIT = 3');
    expect(result.stderr).toContain('RequestPolicy.MODE = 4');
    expect(result.stderr).not.toContain('Color.Red');
    expect(result.stderr).not.toContain('Color.Blue');
  });

  it('flags policy class fields but ignores ordinary class fields', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'class RequestClient {',
        '  readonly retryLimit = 3;',
        '  #timeoutMs = 5_000;',
        '  readonly port = 8080;',
        '}',
        "class RetryPolicy { readonly mode = 'strict'; }",
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RequestClient.retryLimit = 3');
    expect(result.stderr).toContain('RequestClient.#timeoutMs = 5_000');
    expect(result.stderr).toContain("RetryPolicy.mode = 'strict'");
    expect(result.stderr).not.toContain('RequestClient.port');
  });

  it('flags policy-shaped local let declarations', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/policy.ts',
      [
        'function sendRequest() {',
        '  let retryLimit = 3;',
        '  let port = 8080;',
        '  return { retryLimit, port };',
        '}',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sendRequest.retryLimit = 3');
    expect(result.stderr).not.toContain('sendRequest.port');
  });

  it('flags the persona-conformance marker policy specifically', () => {
    const root = makeFixture();
    const source = readFileSync(resolve('src/core/cogsec/persona-conformance.ts'), 'utf8');
    writeSource(root, 'src/core/cogsec/persona-conformance.ts', source);
    writeBaseline(root, []);

    const updateResult = run(root, '--update');

    expect(updateResult.status, updateResult.stderr).toBe(0);
    const baseline = JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), 'utf8')) as {
      entries: Array<{ name: string }>;
    };
    expect(baseline.entries.map(entry => entry.name)).toContain('GENERIC_ASSISTANT_PATTERN');
  });

  it('keeps executable child-source tuning constants visible to the AST scanner', () => {
    const root = makeFixture();
    const source = readFileSync(
      resolve('src/boundary/sandbox/execution/analysis-workbench-child-source.ts'),
      'utf8',
    );
    writeSource(
      root,
      'src/boundary/sandbox/execution/analysis-workbench-child-source.ts',
      source,
    );
    writeBaseline(root, []);

    const updateResult = run(root, '--update');

    expect(updateResult.status, updateResult.stderr).toBe(0);
    const baseline = JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), 'utf8')) as {
      entries: Array<{ name: string }>;
    };
    const names = baseline.entries.map(entry => entry.name);
    expect(names).toContain('MAX_IPC_ARRAY_LENGTH');
    expect(names).toContain('MAX_IPC_DEPTH');
    expect(names).toContain('MAX_IPC_OBJECT_KEYS');
  });

  it('scans executable worker source stored in an ordinary template literal', () => {
    const root = makeFixture();
    writeSource(
      root,
      'src/worker-source.ts',
      [
        'const SESSION_WORKER_SOURCE = `',
        'const RETRY_LIMIT = 3;',
        '`;',
      ].join('\n') + '\n',
    );
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/worker-source.ts:2 RETRY_LIMIT = 3');
  });

  it('ignores tuning constants defined in test files', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.test.ts', 'const RETRY_LIMIT = 3;\n');
    writeBaseline(root, []);

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('regenerates the baseline with --update, preserving and requiring justification notes', () => {
    const root = makeFixture();
    writeSource(root, 'src/policy.ts', 'const RETRY_LIMIT = 3;\n');
    writeSource(root, 'src/guard.ts', 'const MAX_UPLOAD_BYTES = 4 * 1024;\n');
    writeSource(root, 'src/regex-policy.ts', 'const PERSONA_POLICY_PATTERN = /assistant/iu;\n');
    writeBaseline(root, [
      { file: 'src/guard.ts', name: 'MAX_UPLOAD_BYTES', value: '4 * 1024', note: 'zip-bomb guard' },
      { file: 'src/gone.ts', name: 'STALE_TIMEOUT_MS', value: '1' },
    ]);

    const updateResult = run(root, '--update');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    const baseline = JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), 'utf8')) as {
      entries: Array<{ file: string; name: string; value: string; form?: string; note?: string }>;
    };
    const keys = baseline.entries.map(entry => `${entry.file}::${entry.name}`).sort();
    expect(keys).toEqual([
      'src/guard.ts::MAX_UPLOAD_BYTES',
      'src/policy.ts::RETRY_LIMIT',
      'src/regex-policy.ts::PERSONA_POLICY_PATTERN',
    ]);
    const guard = baseline.entries.find(entry => entry.name === 'MAX_UPLOAD_BYTES');
    expect(guard?.note).toBe('zip-bomb guard');

    const regexPolicy = baseline.entries.find(entry => entry.name === 'PERSONA_POLICY_PATTERN');
    expect(regexPolicy?.form).toBe('regex');
    expect(regexPolicy?.note).toBeUndefined();

    // The updater cannot invent a truthful code-ownership justification.
    const missingNoteResult = run(root);
    expect(missingNoteResult.status).toBe(1);
    expect(missingNoteResult.stderr).toContain(
      'extended-form baseline entry requires a non-empty justification note: '
      + 'src/regex-policy.ts::PERSONA_POLICY_PATTERN',
    );

    if (!regexPolicy) throw new Error('expected regenerated regex baseline entry');
    regexPolicy.note = 'Protocol marker intentionally fixed in code.';
    writeBaseline(root, baseline.entries);

    // Verification passes once the new extended-form entry is justified.
    const verifyResult = run(root);
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
  });
});
