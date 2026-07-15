import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve('scripts/verify-postgres-only.mjs');
const RETIRED_PACKAGE = ['better', ['sqli', 'te3'].join('')].join('-');
const RETIRED_MODULE = [['sqli', 'te'].join(''), 'utils'].join('-');
const RETIRED_BACKEND = ['sqli', 'te'].join('');
const roots: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-postgres-only-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { pg: '8.20.0' },
  }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'verification-fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { pg: '8.20.0' } },
      'node_modules/pg': { version: '8.20.0' },
    },
  }));
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
    cwd: root,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Postgres-only repository gate', () => {
  it('accepts a repository with only active persistence packages and sources', () => {
    const result = run(makeFixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[verify-postgres-only] passed');
  });

  it('rejects retired dependencies in package metadata and the lockfile', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { [RETIRED_PACKAGE]: '1.0.0' },
    }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { [`node_modules/${RETIRED_PACKAGE}`]: { version: '1.0.0' } },
    }));

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`forbidden package ${RETIRED_PACKAGE} remains in package.json`);
    expect(result.stderr).toContain(`forbidden package ${RETIRED_PACKAGE} remains in package-lock.json`);
  });

  it('rejects an unclassified retired-backend import', () => {
    const root = makeFixture();
    writeFileSync(
      join(root, 'src', 'database.ts'),
      `import Database from '${RETIRED_PACKAGE}';\n`,
    );

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unclassified retired-backend reference: src/database.ts:1');
  });

  it('rejects unclassified text even when it is not an import', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'src', 'fallback.ts'), `const backend = '${RETIRED_BACKEND}';\n`);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unclassified retired-backend reference: src/fallback.ts:1');
  });

  it('rejects a recreated retired implementation path', () => {
    const root = makeFixture();
    const retiredPath = join(root, 'src', 'persistence', `${RETIRED_MODULE}.ts`);
    mkdirSync(join(root, 'src', 'persistence'), { recursive: true });
    writeFileSync(retiredPath, 'export {};\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`retired implementation path exists: src/persistence/${RETIRED_MODULE}.ts`);
  });
});
