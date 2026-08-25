import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitEnv, mergeEnvContent } from './env-writer.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('mergeEnvContent', () => {
  it('upserts an existing key in place without duplicating it', () => {
    const current = '# secrets\nOPENROUTER_API_KEY=\nOTHER=keep\n';
    const next = mergeEnvContent(current, [{ envName: 'OPENROUTER_API_KEY', value: 'sk-new' }]);
    expect(next).toContain('OPENROUTER_API_KEY=sk-new');
    expect(next).toContain('OTHER=keep');
    expect(next.match(/OPENROUTER_API_KEY=/gu)).toHaveLength(1);
  });

  it('appends a new key with its comment and a separating blank line', () => {
    const next = mergeEnvContent('EXISTING=1\n', [
      { envName: 'DATA_DIR', value: './data', comment: 'runtime data root' },
    ]);
    expect(next).toContain('EXISTING=1');
    expect(next).toContain('# runtime data root');
    expect(next).toContain('DATA_DIR=./data');
  });

  it('quotes values with shell-special characters', () => {
    const next = mergeEnvContent('', [{ envName: 'KEY', value: 'a b"c' }]);
    expect(next).toContain('KEY="a b\\"c"');
  });

  it('creates content from an empty file', () => {
    const next = mergeEnvContent('', [{ envName: 'K', value: 'v' }]);
    expect(next).toBe('K=v\n');
  });

  it('preserves an existing persistent credential instead of rotating it', () => {
    const next = mergeEnvContent('API_KEY=existing-secret\n', [{
      envName: 'API_KEY',
      value: 'new-random-value',
      preserveExisting: true,
    }]);
    expect(next).toContain('API_KEY=existing-secret');
    expect(next).not.toContain('new-random-value');
  });
});

describe('commitEnv', () => {
  it('writes the merged .env to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-env-'));
    dirs.push(dir);
    const envPath = join(dir, '.env');
    commitEnv(envPath, [{ envName: 'OPENROUTER_API_KEY', value: 'sk-abc' }]);
    expect(readFileSync(envPath, 'utf-8')).toContain('OPENROUTER_API_KEY=sk-abc');
  });
});
